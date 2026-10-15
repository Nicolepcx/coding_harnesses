/**
 * CL … C11 and DR: the Claude SWE factory, run headless.
 *
 * One `claude -p` per factory run, in the unit workspace, with the factory's
 * own CLAUDE.md, subagents, skills and hooks. The run ends with a structured
 * evidence bundle (--json-schema). Pi then commits the workspace itself and
 * overwrites patchRef with the real commit: the bundle's claims are checked
 * against that commit, never trusted.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { EvidenceBundle as EvidenceBundleSchema, FindingReview as FindingReviewSchema } from "../src/contracts.ts";
import type { CodexFinding, EvidenceBundle, FindingReview, RecheckResult, UnitSpec } from "../src/contracts.ts";
import type { ClaudeFactory, FactoryRequest } from "../src/ports.ts";
import { exec, lastLine } from "./exec.ts";
import type { Layout } from "./layout.ts";
import { strictSchema } from "./schema.ts";
import { baseRef, commitWorkspace } from "./workspace.ts";
import { StallError } from "../src/lifecycle.ts";

const SYSTEM = [
  "You are running headless inside Pi's migration harness. Nobody can answer questions during the run:",
  "decide, and record assumptions in the evidence bundle. Pi verifies everything you claim against git and",
  "its own frozen acceptance run, and an independent verifier reviews your patch afterwards.",
  "Memory is limited: keep every script you run under 2 GB. Stream or sample instead of building huge tables in memory (for example all Unicode code points); a script that exceeds the budget is killed.",
].join(" ");

interface ClaudeJson {
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  is_error?: boolean;
  subtype?: string;
  num_turns?: number;
  permission_denials?: unknown[];
}

export class HeadlessClaudeFactory implements ClaudeFactory {
  private readonly l: Layout;
  constructor(l: Layout) {
    this.l = l;
  }

  private async claude(
    name: string, prompt: string, schema: unknown, extra: string[], budgetUsd: number, signal: AbortSignal,
    env: Record<string, string> = {},
  ) {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--json-schema", JSON.stringify(schema),
      "--append-system-prompt", SYSTEM,
      "--max-budget-usd", String(budgetUsd),
      ...extra,
    ];
    if (process.env.CLAUDE_MODEL) args.push("--model", process.env.CLAUDE_MODEL);
    await mkdir(this.l.logs, { recursive: true });
    await writeFile(join(this.l.logs, `${name}.prompt.md`), prompt);
    const r = await exec("claude", args, {
      cwd: this.l.workspace, signal, oomScoreAdj: 800, reapGroup: true,
      env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "4", ...env },
    });
    await writeFile(join(this.l.logs, `${name}.json`), r.stdout || "{}");
    await writeFile(join(this.l.logs, `${name}.exit.txt`), `code=${r.code} signal=${r.signal} at ${new Date().toISOString()}\n`);
    if (r.stderr.trim()) await writeFile(join(this.l.logs, `${name}.stderr.log`), r.stderr);
    if (r.aborted) throw new Error(`${name} aborted`);
    if (r.signal || r.code === null) {
      // Killed from outside (usually the kernel's out-of-memory killer). Not an evidence problem: a stall for a person.
      await commitWorkspace(this.l, `${name}: killed by ${r.signal ?? "unknown signal"}, work so far`);
      throw new StallError(`${name} was killed by ${r.signal ?? "a signal"} (likely out of memory, see journalctl -k); the workspace is committed and kept`);
    }
    let out: ClaudeJson = {};
    try {
      out = JSON.parse(r.stdout);
    } catch {
      out = { is_error: true, result: `no JSON from claude (exit ${r.code}): ${lastLine(r.stderr)}` };
    }
    return out;
  }

  async run(req: FactoryRequest, signal: AbortSignal): Promise<{ bundle: EvidenceBundle; costUsd: number }> {
    const base = await baseRef(this.l);
    const prompt = factoryPrompt(req, base);
    const budget = Number(process.env.HARNESS_CLAUDE_RUN_BUDGET ?? 25);
    // A bounded repair narrows what the hooks let the factory write.
    const env: Record<string, string> = {};
    if (req.repair) {
      const claim = join(this.l.state, `claim-${req.repair.id}.json`);
      await writeFile(claim, JSON.stringify({ writable: [...req.repair.allowedPaths, ".factory/**"], forbidden: req.spec.forbiddenPaths }, null, 2));
      env.PI_CLAIM_FILE = claim;
    }
    const out = await this.claude(
      `claude-run${req.runNumber}-${req.entry}`,
      prompt,
      strictSchema(EvidenceBundleSchema),
      ["--permission-mode", "acceptEdits", "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", "Bash", "Agent", "Skill", "TodoWrite"],
      budget,
      signal,
      env,
    );

    // Pi, not the agent, decides what the patch is.
    const patchRef = await commitWorkspace(this.l, `factory run ${req.runNumber} (${req.entry})`);
    const costUsd = out.total_cost_usd ?? 0;
    const raw = out.structured_output;
    if (!raw || typeof raw !== "object") {
      const why = out.is_error ? `${out.subtype ?? "error"}: ${(out.result ?? "").slice(0, 300)}` : "no structured output";
      // An invalid bundle: EV turns this into an evidence defect and sends the factory back to C7.
      const invalid = { unitId: req.spec.unitId, outcome: "candidate", patchRef, missingEvidence: why } as unknown as EvidenceBundle;
      return { bundle: invalid, costUsd };
    }
    const bundle = { ...(raw as EvidenceBundle), patchRef };
    bundle.discoveryRef = existsSync(join(this.l.workspace, ".factory/discovery.md")) ? ".factory/discovery.md" : bundle.discoveryRef ?? null;
    bundle.planRef = existsSync(join(this.l.workspace, ".factory/plan.md")) ? ".factory/plan.md" : bundle.planRef ?? null;
    return { bundle, costUsd };
  }

  async reviewFinding(
    req: { spec: UnitSpec; bundle: EvidenceBundle; finding: CodexFinding; recheck: RecheckResult | null },
    signal: AbortSignal,
  ): Promise<{ review: FindingReview; costUsd: number }> {
    const prompt = reviewPrompt(req, this.l.domain.dataFile);
    const out = await this.claude(
      `claude-review-${req.finding.id}-${Date.now()}`,
      prompt,
      strictSchema(FindingReviewSchema),
      ["--permission-mode", "acceptEdits", "--allowedTools", "Read", "Glob", "Grep", "Bash", "--disallowedTools", "Edit", "Write"],
      5,
      signal,
    );
    const review = out.structured_output as FindingReview;
    if (!Value.Check(FindingReviewSchema, review)) {
      // No valid review means no contest: the finding stands and goes to repair.
      return { review: { findingId: req.finding.id, verdict: "accept", argument: "no valid review produced" }, costUsd: out.total_cost_usd ?? 0 };
    }
    return { review: { ...review, findingId: req.finding.id }, costUsd: out.total_cost_usd ?? 0 };
  }
}

// ─── prompts ─────────────────────────────────────────────────────────────────

const PROCESS = (budget: number) => `
Work as a factory. Use the Agent tool to delegate, and run independent subagents in parallel:

1. C1 classify: read CLAUDE.md and .pi/unit.md. Set riskLevel (you may raise Pi's floor, never lower it).
2. C2–C4 discovery, in parallel: repo-archaeologist, behavior-recorder, persistence-specialist.
   Write the key findings to .factory/discovery.md.
3. C5 plan: split the work into non-overlapping file sets, one per implementer. Write .factory/plan.md.
4. C6 implement: one migration-implementer subagent per file set, in parallel. Port tests/ too,
   keeping every expected value.
5. C7 integrate: make the slices work together on python2.7 and python3.12.
6. C8–C10 internal gates: internal-reviewer and internal-tester (it runs the frozen acceptance from
   acceptance/README.md on both interpreters). Fix and repeat, at most ${budget} iterations.
7. C11 evidence: return the evidence bundle as your structured output.`;

function evidenceRules(req: FactoryRequest, base: string) {
  return `
Evidence bundle rules. Pi checks every claim against git and its own clean-checkout acceptance run:
- unitId: "${req.spec.unitId}".
- changedFiles: exactly the files that differ from the legacy baseline commit ${base.slice(0, 12)}.
  At the end run \`git add -A && git diff --cached --name-only ${base.slice(0, 12)}\` and copy that list.
- testsAdded / testsModified: every changed file under tests/ (modified ones with the reason).
- testsExecuted: commands you actually ran, with passed and failed counts.
- knownBehavioralDifferences: every difference from the legacy build you could not remove (deviationId null;
  only a person assigns deviations). unresolvedRisks: anything else you are unsure about, with a severity.
- internalIterations: how many internal review/test rounds you ran.
- patchRef: "WORKTREE". Do not commit; Pi commits your work and records the commit.
- discoveryRef / planRef: ".factory/discovery.md" / ".factory/plan.md", or null if you did not write them.
- outcome: "candidate", or "internal_budget_exhausted" if the internal gates still fail after the budget.`;
}

function factoryPrompt(req: FactoryRequest, base: string): string {
  const head = `Migration unit ${req.spec.unitId}, factory run ${req.runNumber}, entry ${req.entry}.`;
  const rules = evidenceRules(req, base);
  if (req.entry === "classify") {
    return `${head}
Port this Python 2.7 application to one dual-compatible codebase (python2.7 and python3.12) with
identical observable behavior. The constraints are in .pi/unit.md.
${PROCESS(req.internalRetryBudget)}
${rules}`;
  }
  if (req.entry === "integrate") {
    return `${head}
Pi rejected your last evidence bundle. Do not start over. Fix these evidence defects, change code only
if a defect requires it, re-run the relevant internal checks, and return a corrected bundle:
${req.evidenceDefects.map((d) => `- ${d}`).join("\n")}
${rules}`;
  }
  const r = req.repair!;
  const items = r.items.map((i) => `- [${i.source} ${i.ref}] ${i.summary}${i.files.length ? ` (files: ${i.files.join(", ")})` : ""}`).join("\n");
  const notes = [req.discoveryRef, req.planRef].filter(Boolean).join(" and ");
  const scope = `You may change only: ${r.allowedPaths.join(", ")}. Repair ${r.repairNumber}; ${r.repairsRemaining} left before a person decides.`;
  if (req.entry === "plan") {
    return `${head}
Repair assignment ${r.id}. Pi's frozen acceptance or the independent verifier found failures that mean
the plan misread legacy behavior. Reuse ${notes || "your earlier notes"}, re-examine the behavior on the
legacy build (.pi/legacy/src on python2.7), update .factory/plan.md, then implement, integrate and run
the internal gates again (steps 3–7 of the factory process).
${scope}

Failures to fix:
${items}
${PROCESS(req.internalRetryBudget)}
${rules}`;
  }
  return `${head}
Repair assignment ${r.id}: a local defect. Fix exactly these failures with a migration-implementer,
then run internal-tester on both interpreters before returning (steps 6–7 of the factory process).
${scope}

Failures to fix:
${items}
${rules}`;
}

function reviewPrompt(req: { bundle: EvidenceBundle; finding: CodexFinding; recheck: RecheckResult | null }, dataFile: string): string {
  return `An independent verifier reported this finding against your patch (commit ${req.bundle.patchRef.slice(0, 12)}):

${JSON.stringify(req.finding, null, 2)}
${req.recheck ? `\nA fresh verifier run re-checked your earlier contest and upheld the finding:\n${JSON.stringify(req.recheck, null, 2)}\n` : ""}
Check it yourself: reproduce it against the legacy build (PYTHONPATH=.pi/legacy/src python2.7 ...) and
the port (PYTHONPATH=src on python3.12 and python2.7), on /tmp copies of ${dataFile}. Do not edit files.

Answer "accept" if the finding is real (it then goes to a bounded repair), or "contest" with a concrete,
reproducible argument if it is wrong. Contest only with evidence: a contest that an independent recheck
upholds goes to a person.`;
}
