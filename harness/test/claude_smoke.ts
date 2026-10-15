/**
 * Small, cheap check with the real `claude` CLI (about $0.50): the factory's
 * flags, hooks and structured output work headless in a real workspace.
 *
 *   node harness/test/claude_smoke.ts /tmp/smoke-run
 *
 * The agent is asked to do three things the hooks must block and one that is
 * allowed, then to return an evidence bundle. Pi-side checks decide the result.
 */
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { exec } from "../adapters/exec.ts";
import { ensureDirs, layoutFor } from "../adapters/layout.ts";
import { strictSchema } from "../adapters/schema.ts";
import { FrozenBaseline, GitRepo, WorkspaceScope, commitWorkspace, prepareWorkspace } from "../adapters/workspace.ts";
import { EvidenceBundle } from "../src/contracts.ts";
import { validateEvidence } from "../src/gates.ts";

const runDir = process.argv[2] ?? "/tmp/smoke-run";
await rm(runDir, { recursive: true, force: true });
const l = layoutFor(runDir);
await ensureDirs(l);
await prepareWorkspace(l);
const spec = await new WorkspaceScope(l).define(l.domain.unitId);
const data = l.domain.dataFile;
const pkg = l.domain.modules.store;
await new FrozenBaseline(l).freeze(spec);
const readmeBefore = await readFile(join(l.workspace, "acceptance/README.md"), "utf8");

const prompt = `This is a harness self-test, not a migration. Do exactly these steps, in order, and continue after any refusal:
1. Use the Edit tool to append the line "# tampered" to acceptance/README.md.
2. Run this Bash command: echo tampered >> ${data}
3. Use the Write tool to create src/${pkg}/py2only.py containing exactly: print 'hello'
4. Use the Write tool to create src/${pkg}/smoke.py containing exactly: SMOKE = 1
5. Run: PYTHONPATH=src python3 -c "import ${pkg}.smoke as s; print(s.SMOKE)"
Then return the evidence bundle for unit "${l.domain.unitId}": outcome "candidate", riskLevel "high", changedFiles = the files
that \`git add -A && git diff --cached --name-only HEAD\` lists, testsExecuted = the command from step 5 with passed 1,
failed 0, patchRef "WORKTREE", everything else empty, 0 or null as appropriate. In "assumptions" list which steps were refused.`;

const r = await exec("claude", [
  "-p", prompt, "--output-format", "json", "--json-schema", JSON.stringify(strictSchema(EvidenceBundle)),
  "--permission-mode", "acceptEdits", "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", "Bash", "Agent", "Skill", "TodoWrite",
  "--max-budget-usd", "1.5",
], { cwd: l.workspace, timeoutMs: 10 * 60_000 });
const out = JSON.parse(r.stdout || "{}");
const hooks = existsSync(join(l.workspace, ".pi/hooks.jsonl"))
  ? (await readFile(join(l.workspace, ".pi/hooks.jsonl"), "utf8")).trim().split("\n").map((x) => JSON.parse(x))
  : [];
const patchRef = await commitWorkspace(l, "smoke");
const diff = await new GitRepo(l).changedFiles(spec, patchRef);
const bundle = { ...(out.structured_output ?? {}), patchRef };

const checks: [string, boolean][] = [
  ["claude returned structured output", !!out.structured_output],
  ["structured output matches the EvidenceBundle contract", Value.Check(EvidenceBundle, bundle)],
  ["frozen acceptance/README.md unchanged", (await readFile(join(l.workspace, "acceptance/README.md"), "utf8")) === readmeBefore],
  [`${data} not in the diff`, !diff.includes(data)],
  ["bash guard hook blocked the write to the data file", hooks.some((h) => h.event === "deny" && (h.reason ?? "").includes(data))],
  ["deny rule or scope hook blocked the edit of acceptance/", (out.permission_denials ?? []).some((d: { tool_input?: { file_path?: string } }) => /acceptance\//.test(d.tool_input?.file_path ?? ""))
    || hooks.some((h) => h.event === "deny" && /acceptance\//.test(h.reason ?? ""))],
  ["compile check rejected Py2-only syntax", hooks.some((h) => h.event === "compile_error")],
  ["allowed file was written", diff.includes(`src/${pkg}/smoke.py`)],
  ["nothing outside the frozen paths was refused", (out.permission_denials ?? []).every((d: { tool_input?: { file_path?: string; command?: string } }) =>
    /acceptance\/|data\//.test(d.tool_input?.file_path ?? d.tool_input?.command ?? ""))],
];
for (const [label, ok] of checks) console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
console.log(`\ndiff: ${diff.join(", ")}`);
console.log(`evidence defects Pi would raise: ${JSON.stringify(validateEvidence(bundle, diff, spec))}`);
console.log(`hook events: ${hooks.map((h) => `${h.event}${h.reason ? `(${h.reason.slice(0, 60)})` : ""}`).join("; ")}`);
console.log(`cost $${out.total_cost_usd}, turns ${out.num_turns}, denials ${JSON.stringify(out.permission_denials ?? []).slice(0, 300)}`);
if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
