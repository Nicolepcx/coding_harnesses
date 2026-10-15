/**
 * FA1 … FA6: frozen, deterministic acceptance. No agent in this path.
 *
 * Every run starts from a clean checkout of the patch commit and uses the
 * harness's OWN frozen copies of goldens, specs and scripts (RUN/baseline),
 * never the workspace copies the factory could have touched. The digest step
 * proves the workspace copies are still identical anyway.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcceptanceFailure, AcceptanceResult, AcceptanceStep, BaselineManifest } from "../src/contracts.ts";
import type { AcceptanceRunner } from "../src/ports.ts";
import { exec, lastLine, sha256File } from "./exec.ts";
import type { Layout } from "./layout.ts";
import { checkout } from "./workspace.ts";

type StepResult = AcceptanceResult["steps"][number];
const MAX_FAILURES_PER_CHECK = 12;

export class FrozenAcceptance implements AcceptanceRunner {
  private runs = 0;
  private readonly l: Layout;
  constructor(l: Layout) {
    this.l = l;
  }

  async run(
    req: { baseline: BaselineManifest; patchRef: string; requiredSteps: AcceptanceStep[] },
    signal: AbortSignal,
  ): Promise<AcceptanceResult> {
    this.runs++;
    const tag = `${req.patchRef.slice(0, 10)}-${Date.now()}`;
    const app = await checkout(this.l, req.patchRef, join(this.l.scratch, `fa-${tag}`));
    const reports = join(this.l.reports, `fa-${tag}`);
    await mkdir(reports, { recursive: true });
    const ctx = { app, reports, signal, baseline: req.baseline };

    const all: AcceptanceStep[] = ["digests", "unit_integration", "playwright", "differential", "persistence", "mutation"];
    const steps: StepResult[] = [];
    for (const step of all) {
      if (!req.requiredSteps.includes(step) && step !== "digests") {
        steps.push({ step, status: "skipped", failures: [], metric: null, artifactRef: null });
        continue;
      }
      if (signal.aborted) throw new Error("acceptance aborted");
      const failures = await this.runStep(step, ctx);
      steps.push({
        step,
        status: failures === null ? "skipped" : failures.length ? "fail" : "pass",
        failures: failures ?? [],
        metric: null,
        artifactRef: reports,
      });
    }
    const result: AcceptanceResult = {
      baselineDigest: req.baseline.digest,
      patchRef: req.patchRef,
      steps,
      passed: steps.every((s) => s.status !== "fail" && (s.status === "pass" || !req.requiredSteps.includes(s.step))),
    };
    await writeFile(join(reports, "acceptance.json"), JSON.stringify(result, null, 1));
    return result;
  }

  private async runStep(
    step: AcceptanceStep,
    c: { app: string; reports: string; signal: AbortSignal; baseline: BaselineManifest },
  ): Promise<AcceptanceFailure[] | null> {
    switch (step) {
      case "digests":
        return this.digests(c.app, c.baseline);
      case "unit_integration":
        return this.unitTests(c.app, c.signal);
      case "differential":
        return this.differential(c.app, c.reports, c.signal);
      case "persistence":
        return this.store(c.app, c.reports, c.signal);
      case "playwright":
        return this.playwright(c.app, c.reports, c.signal);
      case "mutation":
        return null; // not part of the demo policy
    }
    return null;
  }

  private b(p: string) {
    return join(this.l.baseline, p);
  }

  /** FA1: frozen assets unchanged, both in the harness copy and in the patch. */
  private async digests(app: string, manifest: BaselineManifest): Promise<AcceptanceFailure[]> {
    const failures: AcceptanceFailure[] = [];
    for (const a of manifest.assets) {
      for (const [where, path] of [["harness copy", this.b(a.path)], ["patch", join(app, a.path)]] as const) {
        const actual = existsSync(path) ? await sha256File(path) : "missing";
        if (actual !== a.sha256) {
          failures.push({ step: "digests", check: `${a.path}`, detail: `${where} of ${a.path} does not match the frozen digest`, files: [a.path] });
        }
      }
    }
    return failures;
  }

  /** FA2: the project's own tests on both interpreters, and none dropped. */
  private async unitTests(app: string, signal: AbortSignal): Promise<AcceptanceFailure[]> {
    const { minTests } = JSON.parse(await readFile(this.b("acceptance/unit_tests.json"), "utf8"));
    const failures: AcceptanceFailure[] = [];
    for (const py of [this.l.py2, this.l.py3]) {
      const r = await exec(py, ["-m", "unittest", "discover", "-s", "tests"], {
        cwd: app, signal, timeoutMs: 10 * 60_000,
        env: { PYTHONPATH: join(app, "src"), PYTHONHASHSEED: "0", PYTHONDONTWRITEBYTECODE: "1", LC_ALL: "C.UTF-8" },
      });
      const ran = Number((r.stderr.match(/Ran (\d+) tests?/) ?? [])[1] ?? 0);
      if (r.code !== 0) {
        const failed = [...r.stderr.matchAll(/^(?:FAIL|ERROR): (\S+) \(([^)]+)\)/gm)].map((m) => (m[2].endsWith(m[1]) ? m[2] : `${m[2]}.${m[1]}`));
        failures.push({
          step: "unit_integration",
          check: `tests@${py}`,
          detail: failed.length ? `failing on ${py}: ${failed.slice(0, 8).join(", ")}` : `test run failed on ${py}: ${lastLine(r.stderr)}`,
          files: [],
        });
      } else if (ran < minTests) {
        failures.push({ step: "unit_integration", check: `test-count@${py}`, detail: `${ran} tests ran on ${py}, legacy suite has ${minTests}`, files: [] });
      }
    }
    return failures;
  }

  private async diffTool(args: string[], json: string, signal: AbortSignal) {
    const r = await exec("python3", [this.b("acceptance/bin/differential.py"), "--domain", this.b("acceptance/domain.json"), ...args, "--json", json], {
      signal, timeoutMs: 20 * 60_000,
    });
    if (!existsSync(json)) throw new Error(`differential tool failed: ${lastLine(r.stderr || r.stdout)}`);
    return JSON.parse(await readFile(json, "utf8")) as { total: number; passed: number; failures: { id: string; detail: string; input?: unknown }[] };
  }

  /** FA4: every recorded CLI and web scenario, on both interpreters. */
  private async differential(app: string, reports: string, signal: AbortSignal): Promise<AcceptanceFailure[]> {
    const failures: AcceptanceFailure[] = [];
    for (const py of [this.l.py3, this.l.py2]) {
      const rep = await this.diffTool(
        ["compare", "--python", py, "--app", app, "--fixture", this.b(this.l.domain.dataFile),
          "--scenarios", this.b("acceptance/differential/scenarios.json"), "--golden", this.b("acceptance/differential/golden.json")],
        join(reports, `differential-${py.split("/").pop()}.json`), signal,
      );
      failures.push(...cap(rep.failures.map((f) => ({
        step: "differential" as const,
        check: `${f.id}@${py.split("/").pop()}`,
        detail: `${JSON.stringify(f.input)} → ${f.detail}`,
        files: [],
      })), `differential@${py}`, rep.failures.length, rep.total));
    }
    return failures;
  }

  /** FA5: persistence, including "can the legacy build still read what the port wrote, with the same types". */
  private async store(app: string, reports: string, signal: AbortSignal): Promise<AcceptanceFailure[]> {
    const failures: AcceptanceFailure[] = [];
    for (const py of [this.l.py3, this.l.py2]) {
      const rep = await this.diffTool(
        ["store", "--python", py, "--app", app, "--fixture", this.b(this.l.domain.dataFile),
          "--golden", this.b("acceptance/differential/store.json"), "--legacy-python", this.l.py2, "--legacy-app", this.b("legacy")],
        join(reports, `store-${py.split("/").pop()}.json`), signal,
      );
      for (const f of rep.failures) {
        failures.push({ step: "persistence", check: `${f.id}@${py.split("/").pop()}`, detail: f.detail, files: [] });
      }
    }
    return failures;
  }

  /** FA3: frozen Playwright specs against the web app on both interpreters. */
  private async playwright(app: string, reports: string, signal: AbortSignal): Promise<AcceptanceFailure[]> {
    const failures: AcceptanceFailure[] = [];
    for (const py of [this.l.py3, this.l.py2]) {
      const short = py.split("/").pop()!;
      const out = join(reports, `playwright-${short}.json`);
      const r = await exec("bash", [this.b("acceptance/run_playwright.sh"), py, app, this.b("acceptance/playwright"), this.b(this.l.domain.dataFile), this.b("acceptance/domain.json"), out], {
        signal, timeoutMs: 10 * 60_000, env: { PW_NODE_MODULES: this.l.pwNodeModules },
      });
      if (r.code === 3) throw new Error(lastLine(r.stderr)); // Playwright missing: infrastructure, not the patch
      const specs = existsSync(out) ? collectSpecs(JSON.parse(await readFile(out, "utf8"))) : [];
      const failed = specs.filter((s) => !s.ok);
      for (const s of failed) {
        failures.push({ step: "playwright", check: `${s.title}@${short}`, detail: s.error, files: [] });
      }
      if (r.code !== 0 && failed.length === 0) {
        failures.push({ step: "playwright", check: `run@${short}`, detail: `Playwright run failed: ${lastLine(r.stderr || r.stdout)}`, files: [] });
      }
    }
    return failures;
  }
}

function cap(list: AcceptanceFailure[], check: string, count: number, total: number): AcceptanceFailure[] {
  if (list.length <= MAX_FAILURES_PER_CHECK) return list;
  const head = list.slice(0, MAX_FAILURES_PER_CHECK);
  head.push({
    step: list[0].step,
    check: `${check}:more`,
    detail: `${count - MAX_FAILURES_PER_CHECK} more of ${total} scenarios differ; full list in the acceptance report`,
    files: [],
  });
  return head;
}

interface PwSuite { title: string; specs?: { title: string; ok: boolean; tests: { results: { error?: { message?: string } }[] }[] }[]; suites?: PwSuite[] }

function collectSpecs(report: { suites?: PwSuite[] }): { title: string; ok: boolean; error: string }[] {
  const out: { title: string; ok: boolean; error: string }[] = [];
  const walk = (s: PwSuite) => {
    for (const spec of s.specs ?? []) {
      const msg = spec.tests.flatMap((t) => t.results).map((r) => r.error?.message ?? "").find(Boolean) ?? "";
      // Strip ANSI colour codes and keep the first meaningful lines.
      const clean = msg.replace(/\u001b\[[0-9;]*m/g, "").split("\n").filter((x) => x.trim()).slice(0, 4).join(" | ");
      out.push({ title: spec.title, ok: spec.ok, error: clean.slice(0, 400) });
    }
    for (const child of s.suites ?? []) walk(child);
  };
  for (const s of report.suites ?? []) walk(s);
  return out;
}
