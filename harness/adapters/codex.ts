/**
 * CV1 … CV5 and RV: independent verification with Codex.
 *
 * Each role is a separate `codex exec` in its OWN clean checkout of the patch,
 * inside Codex's OS sandbox. The builder's instructions (CLAUDE.md, .claude/)
 * are removed from that copy, so the verifier is not primed by the factory.
 * Output is forced into the CodexReport contract (--output-schema) and
 * validated by Pi; an unusable report is a stall, never a silent pass.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { CodexReport as CodexReportSchema, RecheckResult as RecheckResultSchema } from "../src/contracts.ts";
import type {
  AcceptanceResult, BaselineManifest, CodexFinding, CodexReport, FindingReview, RecheckResult, UnitSpec, VerifierRole,
} from "../src/contracts.ts";
import { StallError } from "../src/lifecycle.ts";
import type { CodexVerifier } from "../src/ports.ts";
import { exec, lastLine } from "./exec.ts";
import type { Domain, Layout } from "./layout.ts";
import { writeSchema } from "./schema.ts";
import { baseRef, checkout, git } from "./workspace.ts";
import type { TSchema } from "typebox";

const roleBrief = (d: Domain): Record<VerifierRole, string> => ({
  code_review: `Review the patch (.verify/patch.diff) line by line against the legacy sources in .pi/legacy/src.
Look for behavior the port changed: formatting, ordering, rounding, integer vs float division, str/bytes and
encodings, None handling, sorting, error cases. Prove each suspicion by running legacy and port.`,
  test_gap: `Find legacy behavior that neither tests/ nor the frozen checks in acceptance/ exercise, then try it:
inputs the recorded scenarios do not use (other spellings, transliterations, mixed case, punctuation,
boundaries, unusual numbers and dates, other records). Report untested areas as test_gap and any
difference you can reproduce as behavioral_difference.`,
  exploratory_playwright: `Explore the web front end like a tester. Network sockets may be blocked in your sandbox, so call
the WSGI app in-process: in Python, build an environ with wsgiref.util.setup_testing_defaults, set PATH_INFO
and QUERY_STRING, call ${d.modules.web ?? "the web module"}.make_app(<copy of ${d.dataFile}>)(environ, start_response) and compare
status, headers and the exact body bytes between legacy (python2.7, PYTHONPATH=.pi/legacy/src) and the port
(python3.12 and python2.7, PYTHONPATH=src). Try odd queries, escaping, page numbers and missing ids.`,
  persistence: `Check the data store: the port must read ${d.dataFile} (written by Python 2), keep every value identical
(text, numbers, dates, None, lists, dictionary keys), and whatever the port writes must still be readable by
the legacy build on python2.7 with the same types (protocol, class paths, byte strings vs unicode). Try the
commands that write (${d.storeWrite.map((s) => s[0]).join(", ")}) with non-ASCII input on /tmp copies.`,
  security: `Check that the port did not weaken escaping, input handling or file access compared with the legacy build.`,
});

const common = (d: Domain) => `You are an independent verifier for a Python 2.7 → dual-compatible (python2.7 + python3.12) migration.
You did not write this patch. The legacy build defines correct behavior.

Layout of this directory (a clean checkout of the patch):
- src/, tests/        the ported code and tests
- .pi/legacy/src/     the original Python 2 sources (run them with python2.7)
- ${d.dataFile.padEnd(19)} the production data file written by Python 2; always work on /tmp copies
- acceptance/         frozen checks recorded on the legacy build (already run by the harness; results below)
- .verify/patch.diff  the full patch against the legacy baseline

Run things: PYTHONPATH=src python3.12 -m ${d.modules.cli} COMMAND /tmp/copy ARGS (also python2.7), and the same
with PYTHONPATH=.pi/legacy/src python2.7 for the legacy answer. Do not modify src/ or tests/.
Keep every script you run under 2 GB of memory: stream or sample instead of building huge tables.

Report rules:
- One finding per distinct problem. "files": the source files that need the fix.
- "evidence": the exact command(s), the legacy output and the port output.
- "reproduced": true only if you ran it and saw the difference yourself.
- "severity": your honest estimate; the harness applies its own floor per category.
- "proposedScenarios": checks you think should become part of the frozen acceptance (optional).
- "recommendation": accept, repair or escalate.`;

export class CodexExecVerifier implements CodexVerifier {
  private readonly l: Layout;
  constructor(l: Layout) {
    this.l = l;
  }

  private async prepare(name: string, patchRef: string): Promise<string> {
    const dir = await checkout(this.l, patchRef, join(this.l.scratch, name));
    // Independence: the verifier does not get the builder's instructions or agents.
    await rm(join(dir, "CLAUDE.md"), { force: true });
    await rm(join(dir, ".claude"), { recursive: true, force: true });
    const diff = await git(this.l, "diff", await baseRef(this.l), patchRef, "--", "src", "tests");
    await exec("mkdir", ["-p", join(dir, ".verify")]);
    await writeFile(join(dir, ".verify", "patch.diff"), diff);
    return dir;
  }

  private async codex<T>(name: string, dir: string, prompt: string, schema: TSchema, signal: AbortSignal): Promise<T> {
    const schemaFile = await writeSchema(join(this.l.scratch, "schemas", `${name}.json`), schema);
    const out = join(this.l.logs, `${name}.last.json`);
    await writeFile(join(this.l.logs, `${name}.prompt.md`), prompt);
    const args = ["exec", "--cd", dir, "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral",
      "--color", "never", "--output-schema", schemaFile, "-o", out];
    if (process.env.CODEX_MODEL) args.push("-m", process.env.CODEX_MODEL);
    args.push(prompt);
    let lastError = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      await rm(out, { force: true });
      const r = await exec("codex", args, { signal, logFile: join(this.l.logs, `${name}.log`), oomScoreAdj: 800, reapGroup: true });
      if (r.aborted) throw new Error(`${name} aborted`);
      try {
        const parsed = JSON.parse(await readFile(out, "utf8"));
        if (Value.Check(schema, parsed)) return parsed as T;
        lastError = [...Value.Errors(schema, parsed)].slice(0, 3).map((e) => `${e.instancePath} ${e.message}`).join("; ");
      } catch (e) {
        lastError = `no report (exit ${r.code}): ${lastLine(r.stderr) || (e as Error).message}`;
      }
    }
    throw new StallError(`Codex ${name} produced no valid report: ${lastError}`);
  }

  async verify(
    req: { spec: UnitSpec; role: VerifierRole; patchRef: string; baseline: BaselineManifest; acceptance: AcceptanceResult },
    signal: AbortSignal,
  ): Promise<{ report: CodexReport; costUsd: number }> {
    const name = `codex-${req.role}-${req.patchRef.slice(0, 10)}`;
    const dir = await this.prepare(name, req.patchRef);
    const acc = req.acceptance.steps.map((s) => `${s.step}: ${s.status}`).join(", ");
    const prompt = `${common(this.l.domain)}

Unit ${req.spec.unitId}. Constraints:
${req.spec.constraints.map((c) => `- ${c}`).join("\n")}

Frozen acceptance on this patch: ${acc}. Passing it is necessary, not sufficient: look beyond it.

Your role: ${req.role}.
${roleBrief(this.l.domain)[req.role]}

Return your report with "role": "${req.role}".`;
    const report = await this.codex<CodexReport>(name, dir, prompt, CodexReportSchema, signal);
    // Pi owns identity: the role is the one it launched, ids are unique across roles.
    report.role = req.role;
    report.findings = report.findings.map((f) => ({ ...f, id: `${req.role}-${f.id}` }));
    report.proposedScenarios = report.proposedScenarios.map((s) => ({ ...s, id: `${req.role}-${s.id}` }));
    return { report, costUsd: 0 };
  }

  async recheck(
    req: { spec: UnitSpec; patchRef: string; finding: CodexFinding; review: FindingReview },
    signal: AbortSignal,
  ): Promise<{ result: RecheckResult; costUsd: number }> {
    const name = `codex-recheck-${req.finding.id}-${Date.now()}`;
    const dir = await this.prepare(name, req.patchRef);
    const prompt = `${common(this.l.domain)}

A verifier reported the finding below. The builder contests it with the argument below. You are a fresh,
independent check: reproduce it yourself on legacy and port, then decide.

Finding:
${JSON.stringify(req.finding, null, 2)}

Builder's argument:
${req.review.argument}

Answer "upheld" if the finding is real (behavior differs from legacy, or the risk is real), "withdrawn" if the
builder is right. Explain with the commands you ran. Use "findingId": "${req.finding.id}".`;
    const result = await this.codex<RecheckResult>(name, dir, prompt, RecheckResultSchema, signal);
    return { result: { ...result, findingId: req.finding.id }, costUsd: 0 };
  }
}
