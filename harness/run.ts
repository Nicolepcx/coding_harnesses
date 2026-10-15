/**
 * Suggested plan: run a domain's migration through the Pi lifecycle.
 *
 *   node harness/run.ts RUN_DIR           start, or resume after a crash or reboot
 *   node harness/run.ts RUN_DIR --status  show where the unit is
 *
 * Environment (all optional): HARNESS_DOMAIN (default domains/invoicing), PY2, PY3, PW_NODE_MODULES,
 * HARNESS_BUDGET_USD (whole unit), HARNESS_CLAUDE_RUN_BUDGET (per factory run), HARNESS_REPAIRS,
 * CLAUDE_MODEL, CODEX_MODEL.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { layoutFor } from "./adapters/layout.ts";
import { preflight, runUnit } from "./adapters/runner.ts";

const [runDir, flag] = process.argv.slice(2);
if (!runDir) {
  console.error("usage: node harness/run.ts RUN_DIR [--status]");
  process.exit(2);
}
const l = layoutFor(runDir);

if (flag === "--status") {
  const status = join(l.run, "status.json");
  if (!existsSync(status)) {
    console.log("no status yet");
    process.exit(0);
  }
  const s = JSON.parse(await readFile(status, "utf8"));
  console.log(`node ${s.node} · ${s.status} · ${s.factoryRuns} factory run(s) · ${s.repairs} repair(s) · $${s.costUsd} · ${s.elapsedMin} min`);
  console.log(`trace: ${s.trace.join(" → ")}`);
  if (s.escalation) console.log(`waiting for a person: ${s.escalation.reason} — ${s.escalation.summary}`);
  process.exit(0);
}

const problems = await preflight(l, true);
if (problems.length) {
  console.error("Preflight failed, nothing was started:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

console.log(`Suggested plan · ${l.domain.title} · run directory ${l.run}`);
const state = await runUnit(l);
console.log(`\nFinished: ${state.status} at ${state.node} after ${state.factory.runs} factory run(s), ${state.repair.count} repair(s), $${state.costUsd.toFixed(2)}`);
if (state.checkpointRef) console.log(`Checkpoint: ${state.checkpointRef}`);
console.log(`Audit trail: ${join(l.state, state.unitId)}`);
console.log(`Score it (as root):  tools/score.sh ${l.workspace}`);
