/**
 * End to end with the REAL workspace, baseline, acceptance runner, git and
 * human gate, and scripted agents:
 *   factory run 1 delivers a naive 2to3 port   → frozen acceptance must fail → repair
 *   factory run 2 delivers a correct port       → acceptance passes → Codex → gate → checkpoint
 *
 *   node harness/test/e2e.ts RUN_DIR REFERENCE_APP NAIVE_APP [--escalate]
 *
 * REFERENCE_APP and NAIVE_APP are app directories with src/ (and tests/ for the reference port).
 */
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { FrozenAcceptance } from "../adapters/acceptance.ts";
import { FileHumanGate } from "../adapters/humans.ts";
import { layoutFor } from "../adapters/layout.ts";
import { runUnit } from "../adapters/runner.ts";
import { FrozenBaseline, GitRepo, WorkspaceScope, baseRef, commitWorkspace, git } from "../adapters/workspace.ts";
import type { CodexReport, EvidenceBundle } from "../src/contracts.ts";
import type { Ports } from "../src/ports.ts";
import { policy } from "../config/policy.ts";

const [runDir, referenceApp, naiveApp, mode] = process.argv.slice(2);
// --escalate: the factory never gets it right; after one repair a person must decide (via tools/decide.sh).
const escalate = mode === "--escalate";
await rm(runDir, { recursive: true, force: true });
const l = layoutFor(runDir);

const deliver = async (app: string): Promise<string[]> => {
  const keep = (p: string) => !p.endsWith(".pyc") && !p.includes("__pycache__");
  await rm(join(l.workspace, "src"), { recursive: true, force: true });
  await cp(join(app, "src"), join(l.workspace, "src"), { recursive: true, filter: keep });
  await rm(join(l.workspace, "tests"), { recursive: true, force: true });
  await cp(join(referenceApp, "tests"), join(l.workspace, "tests"), { recursive: true, filter: keep });
  await git(l, "add", "-A");
  return (await git(l, "diff", "--cached", "--name-only", await baseRef(l))).split("\n").filter(Boolean);
};

const calls: string[] = [];
const ports: Ports = {
  scope: new WorkspaceScope(l),
  baseline: new FrozenBaseline(l),
  acceptance: new FrozenAcceptance(l),
  repo: new GitRepo(l),
  humans: new FileHumanGate(l, () => {}),
  factory: {
    async run(req) {
      calls.push(`factory:${req.entry}`);
      const files = await deliver(req.runNumber === 1 || escalate ? naiveApp : referenceApp);
      const patchRef = await commitWorkspace(l, `fake factory run ${req.runNumber}`);
      const bundle: EvidenceBundle = {
        unitId: req.spec.unitId, outcome: "candidate", riskLevel: "high",
        topology: { discovery: ["repo-archaeologist"], implementation: [{ agent: "migration-implementer", scope: ["src/**"] }] },
        migrationScope: "whole app", affectedComponents: req.spec.packages, assumptions: [],
        changedFiles: files, testsAdded: [],
        testsModified: files.filter((f) => f.startsWith("tests/")).map((path) => ({ path, reason: "port test helpers to Python 3" })),
        testsExecuted: [{ command: "unittest", passed: 9, failed: 0 }],
        knownBehavioralDifferences: [], unresolvedRisks: [], internalIterations: 1,
        patchRef, discoveryRef: null, planRef: null,
      };
      return { bundle, costUsd: 1 };
    },
    async reviewFinding() {
      throw new Error("no blocking findings expected");
    },
  },
  codex: {
    async verify(req) {
      calls.push(`codex:${req.role}`);
      const report: CodexReport = {
        role: req.role, testsSelected: [], recommendation: "accept",
        findings: req.role === "test_gap"
          ? [{ id: "test_gap-1", category: "test_gap", severity: "low", summary: "no test for transliterated search", evidence: "-", files: ["tests/test_units.py"], reproduced: false }]
          : [],
        proposedScenarios: req.role === "test_gap"
          ? [{ id: "test_gap-s1", title: "search 'zuerich'", rationale: "transliteration", steps: ["search zuerich"], expected: "legacy output" }]
          : [],
      };
      return { report, costUsd: 0 };
    },
    async recheck() {
      throw new Error("no contest expected");
    },
  },
};

const t = Date.now();
if (escalate) {
  // A person answers the escalation with the CLI, as on the droplet.
  const decide = join(l.harness, "..", "tools", "decide.sh");
  const poll = setInterval(async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(join(l.decisions, "case-1.json")) || existsSync(join(l.decisions, "answer-1.json"))) return;
    clearInterval(poll);
    const { exec } = await import("../adapters/exec.ts");
    console.log((await exec("bash", [decide, l.run])).stdout.trim());
    console.log((await exec("bash", [decide, l.run, "approve", "DEV-1", "try approving"])).stdout.trim() || "(approve refused, as expected)");
    console.log((await exec("bash", [decide, l.run, "reject", "naive port is not acceptable"])).stdout.trim());
  }, 1000);
}
const state = await runUnit(l, {
  ports,
  notify: (line) => console.log(line),
  policy: escalate ? { ...policy, budgets: { ...policy.budgets, repairs: 1 } } : undefined,
});
console.log(`\n${state.status} in ${((Date.now() - t) / 1000).toFixed(0)}s; trace: ${state.trace.join(" ")}`);
console.log(`calls: ${calls.join(", ")}`);
const expected = escalate
  ? ["Q", "S", "B", "CL", "CLAUDE[C1]", "EV", "FA", "FG", "BR", "RT", "CLAUDE[C5]", "EV", "FA", "FG", "BR", "H", "X"]
  : ["Q", "S", "B", "CL", "CLAUDE[C1]", "EV", "FA", "FG", "BR", "RT", "CLAUDE[C5]", "EV", "FA", "FG", "CV", "CV6", "FD", "NR", "AG", "K", "DONE"];
const ok = state.status === (escalate ? "rejected" : "completed") && JSON.stringify(state.trace) === JSON.stringify(expected);
console.log(ok ? "E2E OK" : `E2E MISMATCH, expected ${expected.join(" ")}`);
if (!ok) process.exitCode = 1;
