/**
 * H and NR: the only places a person decides.
 *
 * File-based so it works over SSH, from Pi, or from any UI later:
 *   RUN/decisions/case-N.json     written by Pi: what happened, what is allowed
 *   RUN/decisions/answer-N.json   written by a person (tools/decide.sh)
 * The lifecycle simply waits; everything before the escalation keeps running 24/7.
 */
import { existsSync } from "node:fs";
import { appendFile, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { HumanDecision as HumanDecisionSchema } from "../src/contracts.ts";
import type { HumanDecision, ProposedScenario, ScenarioDecision, UnitSpec } from "../src/contracts.ts";
import type { HumanGate } from "../src/ports.ts";
import type { EscalationCase, UnitState } from "../src/state.ts";
import type { Layout } from "./layout.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FileHumanGate implements HumanGate {
  private readonly l: Layout;
  private readonly notify: (text: string) => void;
  constructor(l: Layout, notify: (text: string) => void = (t) => console.log(t)) {
    this.l = l;
    this.notify = notify;
  }

  private async nextNumber(): Promise<number> {
    const files = existsSync(this.l.decisions) ? await readdir(this.l.decisions) : [];
    const ns = files.map((f) => Number((f.match(/^case-(\d+)\.json$/) ?? [])[1] ?? 0));
    return Math.max(0, ...ns) + 1;
  }

  async decide(c: EscalationCase, state: Readonly<UnitState>): Promise<HumanDecision> {
    // Resume: if a case is already open, keep waiting on it instead of opening another.
    let n = await this.nextNumber();
    const open = join(this.l.decisions, `case-${n - 1}.json`);
    if (n > 1 && existsSync(open) && !existsSync(join(this.l.decisions, `answer-${n - 1}.json`))) n -= 1;
    const caseFile = join(this.l.decisions, `case-${n}.json`);
    const answerFile = join(this.l.decisions, `answer-${n}.json`);
    if (!existsSync(caseFile)) {
      // Every finding that still blocks or that the case is about, whatever its status.
      const open = state.findings.filter((f) =>
        c.findingIds.includes(f.id) ||
        (f.blocking && ["open", "upheld", "accepted", "contested"].includes(f.status)));
      await writeFile(caseFile, JSON.stringify({
        case: n,
        unitId: state.unitId,
        reason: c.reason,
        from: c.from,
        summary: c.summary,
        allowed: c.allowed,
        patchRef: state.bundle?.patchRef ?? null,
        costUsd: Number(state.costUsd.toFixed(2)),
        repairsUsed: state.repair.count,
        findings: open.map((f) => ({
          id: f.id, status: f.status, category: f.category, severity: f.effectiveSeverity,
          reproduced: f.reproduced, files: f.files, summary: f.summary, evidence: f.evidence,
        })),
        knownBehavioralDifferences: state.bundle?.knownBehavioralDifferences ?? [],
        unresolvedRisks: state.bundle?.unresolvedRisks ?? [],
        trace: state.trace.slice(-30),
        howToAnswer: `tools/decide.sh ${this.l.run} ${c.allowed.join("|")} "note"`,
      }, null, 2));
      this.notify(`\n⏸  Needs a person: ${c.reason} — ${c.summary}\n   case file: ${caseFile}\n   answer with: tools/decide.sh ${this.l.run} ${c.allowed.join("|")} "your note"\n`);
    }
    for (;;) {
      if (existsSync(answerFile)) {
        const decision = JSON.parse(await readFile(answerFile, "utf8"));
        if (Value.Check(HumanDecisionSchema, decision) && c.allowed.includes(decision.kind)) return decision;
        await rename(answerFile, `${answerFile}.rejected`);
        this.notify(`answer-${n}.json is not a valid decision for this case (allowed: ${c.allowed.join(", ")}); waiting for a new one`);
      }
      await sleep(5000);
    }
  }

  async reviewScenario(_spec: UnitSpec, scenario: ProposedScenario): Promise<ScenarioDecision> {
    // Demo: proposed scenarios are collected for a person to turn into frozen checks later.
    await appendFile(join(this.l.decisions, "proposed-scenarios.jsonl"), JSON.stringify(scenario) + "\n");
    return { scenarioId: scenario.id, verdict: "informational", note: "logged for later review" };
  }
}
