#!/usr/bin/env python3
"""Hidden behavior suite: record golden outputs on the legacy build, score any build.

Never mount this directory into an agent's workspace. It is the scoreboard,
in the spirit of vals.ai's Code Migration benchmark: a migration is graded by
the share of hidden behavior tests it passes, not by how its code looks.

  record:  runner.py record --python /path/python2.7 --app ../app
  score:   runner.py score  --python /path/python3.12 --app /srv/runs/... [--json report.json]

The scenarios are public; the expected outputs are not. `record` runs the
scenarios on the legacy build with real Python 2.7 and keeps the results in
golden/ on this machine only (git-ignored), so nothing can be looked up.

Every run uses a fresh copy of the ORIGINAL Python 2 data file (fixture/),
so a port cannot dodge the persistence traps by regenerating its data.

Comparison rules
  cli   exit code, stdout with runs of spaces collapsed (column padding is
        cosmetic), and the exact bytes of any collected output file
  http  status code, Content-Type and the exact response body
"""
import argparse
import base64
import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCENARIOS = os.path.join(HERE, "scenarios.json")
SUITE = json.load(open(os.path.join(HERE, "suite.json")))
DATA_NAME = os.path.basename(SUITE["dataFile"])
FIXTURE = os.path.join(HERE, "fixture", DATA_NAME)
STEP_TIMEOUT = 30


def env_for(app):
    env = dict(os.environ)
    env.update({
        "PYTHONPATH": os.path.join(app, "src"),
        "PYTHONHASHSEED": "0",
        "PYTHONIOENCODING": "utf-8",
        "LC_ALL": "C.UTF-8",
        "LANG": "C.UTF-8",
    })
    return env


def b64(data):
    return base64.b64encode(data).decode("ascii")


def unb64(text):
    return base64.b64decode(text.encode("ascii"))


# ─── running scenarios ───────────────────────────────────────────────────────

def run_cli(python, app, scenario):
    tmp = tempfile.mkdtemp(prefix="hidden-")
    try:
        data = os.path.join(tmp, DATA_NAME)
        shutil.copyfile(FIXTURE, data)
        stdout = b""
        exit_code = 0
        stderr_tail = ""
        for step in scenario["steps"]:
            argv = [a.replace("{data}", data).replace("{tmp}", tmp) for a in step]
            try:
                proc = subprocess.run([python, "-m", SUITE["cliModule"]] + argv, cwd=tmp, env=env_for(app),
                                      capture_output=True, timeout=STEP_TIMEOUT)
                stdout += proc.stdout
                exit_code = proc.returncode
                stderr_tail = proc.stderr.decode("utf-8", "replace")[-600:]
            except subprocess.TimeoutExpired:
                exit_code, stderr_tail = -1, "timeout"
            if exit_code != 0:
                break
        stdout = stdout.replace(tmp.encode(), b"{tmp}")
        files = {}
        for name in scenario.get("collect", []):
            path = os.path.join(tmp, name)
            files[name] = b64(open(path, "rb").read()) if os.path.exists(path) else None
        return {"exit": exit_code, "stdout": b64(stdout), "files": files, "stderr": stderr_tail}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Server:
    def __init__(self, python, app):
        self.tmp = tempfile.mkdtemp(prefix="hidden-web-")
        self.data = os.path.join(self.tmp, DATA_NAME)
        shutil.copyfile(FIXTURE, self.data)
        self.port = free_port()
        # stderr goes to a file: an undrained pipe fills with tracebacks and blocks the server
        self.log = os.path.join(self.tmp, "server.log")
        with open(self.log, "wb") as log:
            self.proc = subprocess.Popen([python, "-m", SUITE["webModule"], self.data, str(self.port)],
                                         cwd=self.tmp, env=env_for(app),
                                         stdout=subprocess.DEVNULL, stderr=log)
        self.error = None
        deadline = time.time() + 15
        while time.time() < deadline:
            if self.proc.poll() is not None:
                tail = open(self.log, "rb").read().decode("utf-8", "replace").strip().splitlines()
                self.error = "server exited: " + (tail[-1] if tail else "no output")
                return
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.5).close()
                return
            except OSError:
                time.sleep(0.2)
        self.error = "server did not start within 15s"

    def get(self, path):
        if self.error:
            return {"status": None, "ctype": None, "body": b64(b""), "error": self.error}
        try:
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=STEP_TIMEOUT)
            conn.request("GET", path)
            resp = conn.getresponse()
            body = resp.read()
            result = {"status": resp.status, "ctype": resp.getheader("Content-Type"), "body": b64(body)}
            conn.close()
            return result
        except Exception as e:  # connection reset when the app crashes mid-request
            return {"status": None, "ctype": None, "body": b64(b""), "error": repr(e)}

    def close(self):
        self.proc.kill()
        self.proc.wait()
        shutil.rmtree(self.tmp, ignore_errors=True)


def run_all(python, app, scenarios):
    results = {}
    for s in scenarios:
        if s["kind"] == "cli":
            results[s["id"]] = run_cli(python, app, s)
    http_scenarios = [s for s in scenarios if s["kind"] == "http"]
    if http_scenarios:
        server = Server(python, app)
        try:
            for s in http_scenarios:
                results[s["id"]] = server.get(s["path"])
        finally:
            server.close()
    return results


# ─── comparison ──────────────────────────────────────────────────────────────

def normalize_text(data):
    lines = data.decode("utf-8", "replace").splitlines()
    return [re.sub(r" +", " ", line).strip() for line in lines]


def compare(scenario, golden, actual):
    """Returns None if equal, otherwise a short reason."""
    if scenario["kind"] == "cli":
        if actual["exit"] != golden["exit"]:
            last = actual.get("stderr", "").strip().splitlines()[-1:] or [""]
            return "exit %s (expected %s): %s" % (actual["exit"], golden["exit"], last[0][:160])
        exp, got = normalize_text(unb64(golden["stdout"])), normalize_text(unb64(actual["stdout"]))
        if exp != got:
            for i, (e, g) in enumerate(zip(exp + [""] * len(got), got + [""] * len(exp))):
                if e != g:
                    return "stdout line %d: expected %r, got %r" % (i + 1, e[:70], g[:70])
        for name, data in golden.get("files", {}).items():
            got_file = actual["files"].get(name)
            if got_file is None:
                return "missing output file %s" % name
            if unb64(got_file) != unb64(data):
                e, g = unb64(data), unb64(got_file)
                first = next((i for i in range(min(len(e), len(g))) if e[i] != g[i]), min(len(e), len(g)))
                return "%s differs at byte %d: expected %r, got %r" % (name, first, e[first:first + 24], g[first:first + 24])
        return None
    if actual.get("error") or actual["status"] is None:
        return "request failed: %s" % (actual.get("error", "")[:160])
    if actual["status"] != golden["status"]:
        return "status %s (expected %s)" % (actual["status"], golden["status"])
    if actual["ctype"] != golden["ctype"]:
        return "Content-Type %r (expected %r)" % (actual["ctype"], golden["ctype"])
    e, g = unb64(golden["body"]), unb64(actual["body"])
    if e != g:
        first = next((i for i in range(min(len(e), len(g))) if e[i] != g[i]), min(len(e), len(g)))
        return "body differs at byte %d: expected %r, got %r" % (first, e[first:first + 30], g[first:first + 30])
    return None


# ─── commands ────────────────────────────────────────────────────────────────

def cmd_record(args):
    scenarios = json.load(open(SCENARIOS, encoding="utf-8"))
    os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
    shutil.copyfile(os.path.join(args.app, SUITE["dataFile"]), FIXTURE)
    results = run_all(args.python, args.app, scenarios)
    golden_dir = os.path.join(HERE, "golden")
    os.makedirs(golden_dir, exist_ok=True)
    for s in scenarios:
        r = results[s["id"]]
        r.pop("stderr", None)
        if r.get("error") or (s["kind"] == "cli" and r["exit"] != 0):
            print("WARNING: %s failed on the legacy build: %s" % (s["id"], r.get("error") or r["exit"]))
        with open(os.path.join(golden_dir, s["id"] + ".json"), "w") as f:
            json.dump(r, f, indent=1, sort_keys=True)
    version = subprocess.run([args.python, "-c", "import sys; print(sys.version.split()[0])"],
                             capture_output=True, text=True).stdout.strip()
    print("recorded %d golden outputs with Python %s" % (len(scenarios), version))


def cmd_score(args):
    scenarios = json.load(open(SCENARIOS, encoding="utf-8"))
    golden_dir = os.path.join(HERE, "golden")
    results = run_all(args.python, args.app, scenarios)
    version = subprocess.run([args.python, "-c", "import sys; print(sys.version.split()[0])"],
                             capture_output=True, text=True).stdout.strip()
    rows, passed = [], 0
    for s in scenarios:
        golden = json.load(open(os.path.join(golden_dir, s["id"] + ".json")))
        reason = compare(s, golden, results[s["id"]])
        ok = reason is None
        passed += ok
        rows.append({"id": s["id"], "passed": ok, "reason": reason})
    total = len(scenarios)
    print("Hidden behavior suite · %s · Python %s" % (os.path.abspath(args.app), version))
    print("Score: %d/%d (%.1f%%)\n" % (passed, total, 100.0 * passed / total))
    for r in rows:
        mark = "PASS" if r["passed"] else "FAIL"
        print("%s  %-30s %s" % (mark, r["id"], "" if r["passed"] else r["reason"]))
    if args.json:
        with open(args.json, "w") as f:
            json.dump({"app": os.path.abspath(args.app), "python": version, "passed": passed,
                       "total": total, "score": round(100.0 * passed / total, 1),
                       "results": rows}, f, indent=1)
    return 0 if passed == total else 1


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("record", "score"):
        sp = sub.add_parser(name)
        sp.add_argument("--python", required=True, help="interpreter to run the app with")
        sp.add_argument("--app", required=True, help="app directory containing src/ (and data/ for record)")
        if name == "score":
            sp.add_argument("--json", help="write a JSON report here")
    args = p.parse_args()
    args.app = os.path.abspath(args.app)
    sys.exit(cmd_record(args) if args.cmd == "record" else cmd_score(args))


if __name__ == "__main__":
    main()
