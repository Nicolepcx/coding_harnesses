/**
 * Checks the real acceptance runner against three known builds:
 *   legacy (unchanged)  → must fail on Python 3
 *   naive 2to3 port     → must fail
 *   reference port      → must pass every step
 *
 *   node harness/test/acceptance_check.ts /tmp/acc-run REFERENCE_APP NAIVE_APP
 *
 * REFERENCE_APP and NAIVE_APP are app directories with src/ (and tests/ for the reference port).
 */
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { FrozenAcceptance } from "../adapters/acceptance.ts";
import { ensureDirs, layoutFor } from "../adapters/layout.ts";
import { FrozenBaseline, WorkspaceScope, baseRef, commitWorkspace, prepareWorkspace } from "../adapters/workspace.ts";
import { policy } from "../config/policy.ts";
import { requiredSteps } from "../src/gates.ts";

const [runDir, referenceApp, naiveApp] = process.argv.slice(2);
await rm(runDir, { recursive: true, force: true });
const l = layoutFor(runDir);
await ensureDirs(l);
await prepareWorkspace(l);
const spec = await new WorkspaceScope(l).define(l.domain.unitId);
const baseline = await new FrozenBaseline(l).freeze(spec);
const acceptance = new FrozenAcceptance(l);
const steps = requiredSteps(spec.riskFloor, policy);
console.log(`risk ${spec.riskFloor}, steps ${steps.join(", ")}, ${baseline.assets.length} frozen assets`);

async function check(label: string, ref: string, expectPass: boolean) {
  const t = Date.now();
  const r = await acceptance.run({ baseline, patchRef: ref, requiredSteps: steps }, new AbortController().signal);
  const summary = r.steps.map((s) => `${s.step}:${s.status}${s.failures.length ? `(${s.failures.length})` : ""}`).join(" ");
  const ok = r.passed === expectPass;
  console.log(`${ok ? "OK  " : "BAD "} ${label.padEnd(10)} passed=${r.passed}  ${summary}  ${((Date.now() - t) / 1000).toFixed(1)}s`);
  for (const f of r.steps.flatMap((s) => s.failures).slice(0, 3)) console.log(`       ${f.step} ${f.check}: ${f.detail.slice(0, 150)}`);
  if (!ok) process.exitCode = 1;
}

await check("legacy", await baseRef(l), false);

const swap = async (app: string, label: string) => {
  const keep = (p: string) => !p.endsWith(".pyc") && !p.includes("__pycache__");
  await rm(join(l.workspace, "src"), { recursive: true, force: true });
  await cp(join(app, "src"), join(l.workspace, "src"), { recursive: true, filter: keep });
  await rm(join(l.workspace, "tests"), { recursive: true, force: true });
  await cp(join(referenceApp, "tests"), join(l.workspace, "tests"), { recursive: true, filter: keep });
  return commitWorkspace(l, label);
};
await check("naive", await swap(naiveApp, "naive port"), false);
await check("reference", await swap(referenceApp, "reference port"), true);
