#!/usr/bin/env python3
"""Frozen differential acceptance: legacy (Python 2.7) behavior is the oracle.

  generate  derive scenarios with the domain's generator from the legacy data
  record    run the scenarios on the legacy build and store golden outputs
  compare   run them on a candidate build and report every difference
  store     persistence check: can the candidate read the Python 2 data file,
            does it keep the content when it writes, and can the LEGACY build
            still read what the candidate wrote, with the same types?

Everything domain-specific (module names, the data file, the write command,
the scenario generator) comes from the domain config (--domain domain.json).

Comparison rules (same spirit as any behavior test):
  cli   exit code, stdout with runs of spaces collapsed, bytes of collected files
  http  status code, Content-Type and the exact body
"""
import argparse
import base64
import http.client
import importlib.util
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
INSPECT = os.path.join(HERE, "inspect_store.py")
STEP_TIMEOUT = 15
DOMAIN = {}


def env_for(app):
    env = dict(os.environ)
    env.update({
        "PYTHONPATH": os.path.join(os.path.abspath(app), "src"),
        "PYTHONHASHSEED": "0",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "LC_ALL": "C.UTF-8",
        "LANG": "C.UTF-8",
        "STORE_MODULE": DOMAIN["modules"]["store"],
        "STORE_OPEN": DOMAIN.get("storeOpen", "open_root"),
    })
    return env


def data_name():
    return os.path.basename(DOMAIN["dataFile"])


def b64(data):
    return base64.b64encode(data).decode("ascii")


def inspect(python, app, data, types=False):
    args = [python, INSPECT, data] + (["--types"] if types else [])
    proc = subprocess.run(args, env=env_for(app), capture_output=True, timeout=STEP_TIMEOUT * 4)
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        return None, tail[-1] if tail else "exit %d" % proc.returncode
    return json.loads(proc.stdout.decode("utf-8")), None


def dict_items(node):
    return node["dict"] if isinstance(node, dict) and "dict" in node else []


# ─── running ─────────────────────────────────────────────────────────────────

def normalize(stdout, tmp):
    stdout = stdout.replace(tmp.encode(), b"{tmp}")
    return re.sub(rb"[ \t]+", b" ", stdout)


def run_steps(python, app, data, tmp, steps):
    stdout, code, err = b"", 0, ""
    for step in steps:
        argv = [a.replace("{data}", data).replace("{tmp}", tmp) for a in step]
        try:
            proc = subprocess.run([python, "-m", DOMAIN["modules"]["cli"]] + argv, cwd=tmp, env=env_for(app),
                                  capture_output=True, timeout=STEP_TIMEOUT)
            stdout += proc.stdout
            code = proc.returncode
            err = proc.stderr.decode("utf-8", "replace")[-400:]
        except subprocess.TimeoutExpired:
            code, err = -1, "timeout"
        if code != 0:
            break
    return stdout, code, err


def run_cli(python, app, fixture, scenario):
    tmp = tempfile.mkdtemp(prefix="diff-")
    try:
        data = os.path.join(tmp, data_name())
        shutil.copyfile(fixture, data)
        stdout, code, err = run_steps(python, app, data, tmp, scenario["steps"])
        files = {}
        for name in scenario.get("collect", []):
            path = os.path.join(tmp, name)
            files[name] = b64(open(path, "rb").read()) if os.path.exists(path) else None
        return {"exit": code, "stdout": b64(normalize(stdout, tmp)), "files": files}, err
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Server:
    def __init__(self, python, app, fixture):
        self.tmp = tempfile.mkdtemp(prefix="diffweb-")
        data = os.path.join(self.tmp, data_name())
        shutil.copyfile(fixture, data)
        self.port = free_port()
        # stderr goes to a file: a pipe nobody drains fills up with tracebacks and blocks the server
        self.log = os.path.join(self.tmp, "server.log")
        with open(self.log, "wb") as log:
            self.proc = subprocess.Popen([python, "-m", DOMAIN["modules"]["web"], data, str(self.port)],
                                         cwd=self.tmp, env=env_for(app), stdout=subprocess.DEVNULL, stderr=log)
        self.error = None
        deadline = time.time() + 10
        while time.time() < deadline:
            if self.proc.poll() is not None:
                tail = open(self.log, "rb").read().decode("utf-8", "replace").strip().splitlines()
                self.error = "server exited: " + (tail[-1] if tail else "no output")
                return
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.5).close()
                return
            except OSError:
                time.sleep(0.1)
        self.error = "server did not start within 10s"

    def get(self, path):
        if self.error:
            return {"status": None, "type": None, "body": ""}, self.error
        try:
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=STEP_TIMEOUT)
            conn.request("GET", path)
            res = conn.getresponse()
            body = res.read()
            conn.close()
            return {"status": res.status, "type": res.getheader("Content-Type"), "body": b64(body)}, ""
        except Exception as e:  # noqa: BLE001 - any transport error is a behavior difference
            return {"status": None, "type": None, "body": ""}, "%s: %s" % (type(e).__name__, e)

    def close(self):
        self.proc.kill()
        self.proc.wait()
        shutil.rmtree(self.tmp, ignore_errors=True)


def run_all(python, app, fixture, scenarios):
    results, errors = {}, {}
    server = None
    try:
        for sc in scenarios:
            if sc["kind"] == "cli":
                results[sc["id"]], errors[sc["id"]] = run_cli(python, app, fixture, sc)
            else:
                if server is None:
                    server = Server(python, app, fixture)
                results[sc["id"]], errors[sc["id"]] = server.get(sc["path"])
    finally:
        if server:
            server.close()
    return results, errors


def describe(expected, actual):
    """A short, human-readable account of the first difference."""
    for key in ("exit", "status", "type"):
        if key in expected and expected[key] != actual.get(key):
            return "%s: expected %r, got %r" % (key, expected[key], actual.get(key))
    for key in ("stdout", "body"):
        if key in expected and expected[key] != actual.get(key):
            e = base64.b64decode(expected[key]).decode("utf-8", "replace").splitlines()
            a = base64.b64decode(actual.get(key) or "").decode("utf-8", "replace").splitlines()
            for i in range(max(len(e), len(a))):
                el = e[i] if i < len(e) else "<missing>"
                al = a[i] if i < len(a) else "<missing>"
                if el != al:
                    return "%s line %d: expected %r, got %r" % (key, i + 1, el[:160], al[:160])
            return "%s differs" % key
    for name, data in (expected.get("files") or {}).items():
        got = (actual.get("files") or {}).get(name)
        if got != data:
            if got is None:
                return "file %s was not written" % name
            e = base64.b64decode(data)
            a = base64.b64decode(got)
            i = next((k for k in range(min(len(e), len(a))) if e[k] != a[k]), min(len(e), len(a)))
            return "file %s differs at byte %d: expected %r, got %r" % (name, i, e[i:i + 40], a[i:i + 40])
    return "differs"


# ─── store (persistence) check ───────────────────────────────────────────────

def store_snapshots(python, app, fixture, legacy_python=None, legacy_app=None):
    """The views the persistence gate compares."""
    out = {}
    view, err = inspect(python, app, fixture)
    out["read_original"] = view if view is not None else {"error": err}
    tmp = tempfile.mkdtemp(prefix="store-")
    try:
        data = os.path.join(tmp, data_name())
        shutil.copyfile(fixture, data)
        _, code, err = run_steps(python, app, data, tmp, DOMAIN["storeWrite"])
        if code != 0:
            tail = err.strip().splitlines()
            failed = {"error": "write failed: %s" % (tail[-1] if tail else code)}
            out["after_write"] = failed
            if legacy_python:
                out["legacy_reads_written"] = failed
        else:
            view, err = inspect(python, app, data)
            out["after_write"] = view if view is not None else {"error": err}
            if legacy_python:
                view, err = inspect(legacy_python, legacy_app, data, types=True)
                out["legacy_reads_written"] = view if view is not None else {"error": err}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return out


# ─── commands ────────────────────────────────────────────────────────────────

def cmd_generate(a):
    root, err = inspect(a.python, a.app, a.fixture)
    if root is None:
        sys.exit("cannot read %s with the legacy build: %s" % (a.fixture, err))
    spec = importlib.util.spec_from_file_location("domain_scenarios", a.generator)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    sc = mod.generate(root, dict_items)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(sc, f, indent=1, ensure_ascii=False)
    print("%d scenarios -> %s" % (len(sc), a.out))


def cmd_record(a):
    scenarios = json.load(open(a.scenarios, encoding="utf-8"))
    results, errors = run_all(a.python, a.app, a.fixture, scenarios)
    store = store_snapshots(a.python, a.app, a.fixture)
    # What the legacy build itself sees after its own write, with Python 2 types.
    tmp = tempfile.mkdtemp(prefix="store-rec-")
    try:
        data = os.path.join(tmp, data_name())
        shutil.copyfile(a.fixture, data)
        run_steps(a.python, a.app, data, tmp, DOMAIN["storeWrite"])
        view, err = inspect(a.python, a.app, data, types=True)
        store["legacy_reads_written"] = view if view is not None else {"error": err}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    with open(a.out, "w") as f:
        json.dump({"python": a.python, "results": results}, f, indent=1)
    with open(a.store_out, "w") as f:
        json.dump(store, f, indent=1)
    errored = [k for k, v in results.items() if v.get("exit") not in (0, None) or v.get("status") not in (200, None)]
    print("recorded %d scenarios on the legacy build (%d legacy errors, kept as behavior)" % (len(results), len(errored)))


def cmd_compare(a):
    scenarios = json.load(open(a.scenarios, encoding="utf-8"))
    golden = json.load(open(a.golden))["results"]
    results, errors = run_all(a.python, a.app, a.fixture, scenarios)
    failures = []
    for sc in scenarios:
        exp, act = golden[sc["id"]], results[sc["id"]]
        if exp != act:
            detail = describe(exp, act)
            if errors.get(sc["id"]):
                detail += " | stderr: " + errors[sc["id"]].strip().splitlines()[-1][:200]
            failures.append({"id": sc["id"], "input": sc.get("steps") or sc.get("path"), "detail": detail})
    report = {"python": a.python, "total": len(scenarios), "passed": len(scenarios) - len(failures), "failures": failures}
    if a.json:
        with open(a.json, "w") as f:
            json.dump(report, f, indent=1, ensure_ascii=False)
    print("%d/%d differential scenarios match legacy on %s" % (report["passed"], report["total"], a.python))
    for f in failures[: a.show]:
        print("  FAIL %-28s %s" % (f["id"], f["detail"][:220]))
    return 0 if not failures else 1


def first_difference(expected, got):
    e = json.dumps(expected, sort_keys=True, ensure_ascii=False)
    g = json.dumps(got, sort_keys=True, ensure_ascii=False)
    i = next((k for k in range(min(len(e), len(g))) if e[k] != g[k]), min(len(e), len(g)))
    return "expected …%s… got …%s…" % (e[max(0, i - 60):i + 60], g[max(0, i - 60):i + 60])


def cmd_store(a):
    golden = json.load(open(a.golden))
    got = store_snapshots(a.python, a.app, a.fixture, a.legacy_python, a.legacy_app)
    labels = {
        "read_original": "candidate reads the Python 2 data file",
        "after_write": "candidate writes and reads its own file back",
        "legacy_reads_written": "legacy build reads the candidate's file (same content and types)",
    }
    failures = []
    for key, label in labels.items():
        if key not in got:
            continue
        if got[key] != golden[key]:
            if isinstance(got[key], dict) and "error" in got[key]:
                detail = got[key]["error"]
            else:
                detail = "content differs from legacy: " + first_difference(golden[key], got[key])
            failures.append({"id": key, "detail": "%s: %s" % (label, detail)})
    report = {"python": a.python, "total": len([k for k in labels if k in got]), "failures": failures}
    report["passed"] = report["total"] - len(failures)
    if a.json:
        with open(a.json, "w") as f:
            json.dump(report, f, indent=1, ensure_ascii=False)
    print("%d/%d persistence checks match legacy on %s" % (report["passed"], report["total"], a.python))
    for f in failures:
        print("  FAIL %s" % f["detail"][:300])
    return 0 if not failures else 1


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--domain", required=True, help="domain.json (module names, data file, write command)")
    sub = p.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate")
    g.add_argument("--python", required=True)
    g.add_argument("--app", required=True)
    g.add_argument("--fixture", required=True)
    g.add_argument("--generator", required=True)
    g.add_argument("--out", required=True)
    r = sub.add_parser("record")
    r.add_argument("--python", required=True)
    r.add_argument("--app", required=True)
    r.add_argument("--fixture", required=True)
    r.add_argument("--scenarios", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--store-out", required=True)
    c = sub.add_parser("compare")
    c.add_argument("--python", required=True)
    c.add_argument("--app", required=True)
    c.add_argument("--fixture", required=True)
    c.add_argument("--scenarios", required=True)
    c.add_argument("--golden", required=True)
    c.add_argument("--json")
    c.add_argument("--show", type=int, default=15)
    s = sub.add_parser("store")
    s.add_argument("--python", required=True)
    s.add_argument("--app", required=True)
    s.add_argument("--fixture", required=True)
    s.add_argument("--golden", required=True)
    s.add_argument("--legacy-python")
    s.add_argument("--legacy-app")
    s.add_argument("--json")
    a = p.parse_args()
    DOMAIN.update(json.load(open(a.domain, encoding="utf-8")))
    for attr in ("app", "legacy_app", "fixture", "generator"):
        if getattr(a, attr, None):
            setattr(a, attr, os.path.abspath(getattr(a, attr)))
    return {"generate": cmd_generate, "record": cmd_record, "compare": cmd_compare, "store": cmd_store}[a.cmd](a) or 0


if __name__ == "__main__":
    sys.exit(main())
