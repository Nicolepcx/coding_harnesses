/**
 * Pi-owned migration lifecycle.
 *
 * One handler per flowchart node. Each handler reads the durable UnitState,
 * calls at most one kind of port, and returns the next node. The runner
 * persists state and writes an audit event after every transition, so a crash
 * or restart resumes at the last node instead of losing the unit.
 *
 * Claude and Codex never call each other. Every handoff between them goes
 * through a handler here.
 */
import type { HumanDecision, RepairItem } from "./contracts.ts";
import {
  acceptanceRepairItems,
  decideRepairEntry,
  detectOscillation,
  effectiveRisk,
  evaluateAcceptance,
  finalGate,
  joinFindings,
  repairAllowedPaths,
  requiredSteps,
  reviewable,
  signatureOf,
  validateEvidence,
} from "./gates.ts";
import type { Policy } from "./policy.ts";
import type { Ports } from "./ports.ts";
import { ENTRY_NODE, TERMINAL, initialState, type EscalationCase, type NodeId, type TrackedFinding, type UnitState } from "./state.ts";
import type { UnitStore } from "./store.ts";

export class StallError extends Error {}

/**
 * A Codex finding as a repair item. Its ref is the finding's content
 * fingerprint (category + files), not Codex's ID: Codex numbers its findings
 * anew in every run, so IDs cannot tell "the same problem came back".
 */
function codexItem(f: TrackedFinding): RepairItem {
  return { source: "codex", ref: f.fingerprint, summary: `${f.id}: ${f.summary}`, files: f.files };
}

type Step = { next: NodeId; note: string; refs?: string[] };
type Handler = (s: UnitState) => Promise<Step>;

export interface LifecycleOptions {
  /** Called after every persisted transition (Pi uses it for status/widgets). */
  onTransition?: (s: Readonly<UnitState>, step: Step & { from: NodeId }) => void;
}

export class MigrationLifecycle {
  private readonly ports: Ports;
  private readonly policy: Policy;
  private readonly store: UnitStore;
  private readonly opts: LifecycleOptions;
  private readonly handlers: Record<NodeId, Handler>;

  constructor(ports: Ports, policy: Policy, store: UnitStore, opts: LifecycleOptions = {}) {
    this.ports = ports;
    this.policy = policy;
    this.store = store;
    this.opts = opts;
    this.handlers = {
      Q: this.queued, S: this.defineScope, B: this.freezeBaseline, CL: this.launchFactory,
      CLAUDE: this.runFactory, EV: this.validateEvidence, ER: this.returnEvidenceDefect,
      FA: this.runFrozenAcceptance, FG: this.frozenGate, BR: this.boundedRepair, RT: this.routeRepair,
      CV: this.launchCodex, CV6: this.joinFindings, FD: this.findingDecision, DR: this.claudeReviewsFinding,
      DC: this.priorContest, RV: this.codexRecheck, NR: this.reviewScenario, UB: this.updateBaseline,
      AG: this.acceptanceGate, H: this.humanReview, K: this.checkpoint, X: this.terminal, DONE: this.terminal,
    };
  }

  /** Runs a unit to a terminal node, resuming from persisted state if present. */
  async run(unitId: string): Promise<UnitState> {
    const state = (await this.store.load(unitId)) ?? initialState(unitId);
    if (state.trace.length === 0) {
      state.trace.push("Q");
      await this.store.save(state);
    }
    while (!TERMINAL.includes(state.node)) {
      const from = state.node;
      let step: Step;
      try {
        step = await this.handlers[from](state);
      } catch (e) {
        if (!(e instanceof StallError)) throw e; // crash: state stays at `from`; Pi resumes later
        step = this.escalate(state, { reason: "stalled", from, summary: e.message, findingIds: [] });
      }
      state.node = step.next;
      state.trace.push(this.label(state));
      state.updatedAt = new Date().toISOString();
      await this.store.save(state);
      await this.store.audit({ ts: state.updatedAt, unitId, from, to: step.next, note: step.note, refs: step.refs });
      this.opts.onTransition?.(state, { ...step, from });
    }
    return state;
  }

  private label(s: UnitState): string {
    return s.node === "CLAUDE" ? `CLAUDE[${ENTRY_NODE[s.factory.entry]}]` : s.node;
  }

  /** Runs a port call with a wall-clock limit. A timeout is a stall, not a crash. */
  private async guarded<T>(what: string, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new StallError(`${what} exceeded ${Math.round(ms / 1000)}s`));
      }, ms);
    });
    try {
      return await Promise.race([fn(ctrl.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private spend(s: UnitState, usd: number): Step | null {
    s.costUsd += usd;
    if (s.costUsd > this.policy.budgets.costUsd) {
      return this.escalate(s, {
        reason: "cost_budget_exhausted",
        from: s.node,
        summary: `spent $${s.costUsd.toFixed(2)} of $${this.policy.budgets.costUsd}`,
        findingIds: [],
      });
    }
    return null;
  }

  private escalate(s: UnitState, c: Omit<EscalationCase, "allowed">): Step {
    const allowed: HumanDecision["kind"][] = ["reject", "suspend"];
    if (s.bundle) allowed.push("require_repair");
    const acceptancePassed =
      s.spec && s.bundle && s.baseline && s.acceptance &&
      evaluateAcceptance(s.acceptance, effectiveRisk(s.spec, s.bundle), s.baseline.digest, s.bundle.patchRef, this.policy).passed;
    if (acceptancePassed) allowed.push("approve_difference");
    s.escalation = { ...c, allowed };
    return { next: "H", note: `escalate: ${c.reason} — ${c.summary}` };
  }

  // ─── Q → S → B → CL ────────────────────────────────────────────────────────

  private queued: Handler = async () => ({ next: "S", note: "unit picked from queue" });

  private defineScope: Handler = async (s) => {
    s.spec = await this.ports.scope.define(s.unitId);
    const ref = await this.store.artifact(s.unitId, "spec", s.spec);
    return { next: "B", note: `risk floor ${s.spec.riskFloor} (${s.spec.riskSignals.join(", ") || "no signals"})`, refs: [ref] };
  };

  private freezeBaseline: Handler = async (s) => {
    s.baseline = await this.ports.baseline.freeze(s.spec!);
    const ref = await this.store.artifact(s.unitId, `baseline-v${s.baseline.version}`, s.baseline);
    return { next: "CL", note: `baseline v${s.baseline.version} frozen (${s.baseline.assets.length} assets)`, refs: [ref] };
  };

  private launchFactory: Handler = async (s) => {
    s.factory.entry = "classify";
    return { next: "CLAUDE", note: "launch Claude SWE factory at C1" };
  };

  // ─── CLAUDE: C1 … C11 (one headless factory run) ───────────────────────────

  private runFactory: Handler = async (s) => {
    const req = {
      spec: s.spec!,
      baseline: s.baseline!,
      entry: s.factory.entry,
      runNumber: s.factory.runs + 1,
      internalRetryBudget: this.policy.budgets.internalRetries,
      discoveryRef: s.factory.discoveryRef,
      planRef: s.factory.planRef,
      repair: s.factory.entry === "plan" || s.factory.entry === "implement" ? s.repair.current : null,
      evidenceDefects: s.factory.entry === "integrate" ? s.evidenceDefects : [],
      previousPatchRef: s.bundle?.patchRef ?? null,
    };
    const { bundle, costUsd } = await this.guarded("Claude factory run", this.policy.timeouts.factoryRun, (sig) =>
      this.ports.factory.run(req, sig),
    );
    s.factory.runs++;
    const ref = await this.store.artifact(s.unitId, `bundle-run${s.factory.runs}`, bundle);

    // A new patch invalidates everything computed for the previous one.
    if (bundle.patchRef !== s.bundle?.patchRef) {
      s.acceptance = null;
      s.findings = [];
      s.findingsPatchRef = null;
      s.contests = {};
    }
    s.bundle = bundle;
    s.factory.discoveryRef = bundle.discoveryRef ?? s.factory.discoveryRef;
    s.factory.planRef = bundle.planRef ?? s.factory.planRef;
    s.repair.pendingItems = [];

    const over = this.spend(s, costUsd);
    if (over) return over;
    if (bundle.outcome === "internal_budget_exhausted") {
      return this.escalate(s, {
        reason: "internal_budget_exhausted",
        from: "CLAUDE",
        summary: `internal gates still failing after ${bundle.internalIterations} iterations`,
        findingIds: [],
      });
    }
    return { next: "EV", note: `C11 bundle for ${bundle.patchRef}`, refs: [ref] };
  };

  // ─── EV / ER ───────────────────────────────────────────────────────────────

  private validateEvidence: Handler = async (s) => {
    const diff = await this.ports.repo.changedFiles(s.spec!, s.bundle!.patchRef);
    const defects = validateEvidence(s.bundle, diff, s.spec!);
    if (defects.length === 0) {
      s.evidenceDefects = [];
      return { next: "FA", note: "evidence bundle valid" };
    }
    s.evidenceDefects = defects;
    return { next: "ER", note: `evidence defects: ${defects.join("; ")}` };
  };

  private returnEvidenceDefect: Handler = async (s) => {
    s.evidenceDefectReturns++;
    if (s.evidenceDefectReturns > this.policy.budgets.evidenceDefects) {
      return this.escalate(s, {
        reason: "evidence_budget_exhausted",
        from: "ER",
        summary: s.evidenceDefects.join("; "),
        findingIds: [],
      });
    }
    s.factory.entry = "integrate";
    return { next: "CLAUDE", note: `return to C7 (${s.evidenceDefectReturns}/${this.policy.budgets.evidenceDefects})` };
  };

  // ─── FA / FG ───────────────────────────────────────────────────────────────

  private runFrozenAcceptance: Handler = async (s) => {
    const risk = effectiveRisk(s.spec!, s.bundle);
    s.acceptance = await this.guarded("frozen acceptance", this.policy.timeouts.acceptance, (sig) =>
      this.ports.acceptance.run(
        { spec: s.spec!, baseline: s.baseline!, patchRef: s.bundle!.patchRef, requiredSteps: requiredSteps(risk, this.policy) },
        sig,
      ),
    );
    const ref = await this.store.artifact(s.unitId, `acceptance-run${s.factory.runs}-v${s.baseline!.version}`, s.acceptance);
    return { next: "FG", note: `frozen acceptance ran at risk ${risk}`, refs: [ref] };
  };

  private frozenGate: Handler = async (s) => {
    const result = evaluateAcceptance(
      s.acceptance!, effectiveRisk(s.spec!, s.bundle), s.baseline!.digest, s.bundle!.patchRef, this.policy,
    );
    if (!result.integrity) {
      return this.escalate(s, {
        reason: "baseline_integrity",
        from: "FG",
        summary: "frozen asset digests or result binding do not match",
        findingIds: [],
      });
    }
    if (result.passed) return { next: "CV", note: "frozen acceptance passed" };
    s.repair.pendingItems = acceptanceRepairItems(result.failures);
    return { next: "BR", note: `frozen acceptance failed: ${result.failures.map((f) => `${f.step}:${f.check}`).join(", ")}` };
  };

  // ─── BR / RT ───────────────────────────────────────────────────────────────

  private boundedRepair: Handler = async (s) => {
    const items = s.repair.pendingItems;
    const signatures = items.map(signatureOf);
    const limit = this.policy.budgets.repairs + s.repair.extraGranted;
    if (s.repair.count >= limit) {
      return this.escalate(s, {
        reason: "repair_budget_exhausted",
        from: "BR",
        summary: `${s.repair.count} repairs used; still failing: ${signatures.join(", ")}`,
        findingIds: s.findings.filter((f) => items.some((i) => i.source === "codex" && i.ref === f.fingerprint)).map((f) => f.id),
      });
    }
    const oscillating = detectOscillation(s.repair.history, signatures);
    if (oscillating.length) {
      return this.escalate(s, {
        reason: "oscillation",
        from: "BR",
        summary: `previously fixed failures returned: ${oscillating.join(", ")}`,
        findingIds: [],
      });
    }
    return { next: "RT", note: `repair ${s.repair.count + 1}/${limit}: ${signatures.join(", ")}` };
  };

  private routeRepair: Handler = async (s) => {
    const items = s.repair.pendingItems;
    const { entry, reason } = decideRepairEntry(items, s.repair.history, this.policy);
    s.repair.count++;
    const limit = this.policy.budgets.repairs + s.repair.extraGranted;
    s.repair.current = {
      id: `${s.unitId}-repair-${s.repair.count}`,
      unitId: s.unitId,
      entry,
      items,
      allowedPaths: repairAllowedPaths(items, s.spec!, entry),
      repairNumber: s.repair.count,
      repairsRemaining: limit - s.repair.count,
    };
    s.repair.history.push({ number: s.repair.count, entry, signatures: items.map(signatureOf) });
    for (const f of s.findings) if (f.status === "accepted") f.sentToRepair = true;
    s.factory.entry = entry;
    const ref = await this.store.artifact(s.unitId, s.repair.current.id, s.repair.current);
    return { next: "CLAUDE", note: `${entry === "plan" ? "replan at C5" : "re-implement at C6"}: ${reason}`, refs: [ref] };
  };

  // ─── CV … CV6: Pi-managed Codex runs ───────────────────────────────────────

  private launchCodex: Handler = async (s) => {
    const patchRef = s.bundle!.patchRef;
    if (s.codex.patchRef === patchRef && s.codex.reports.length) {
      return { next: "CV6", note: `reusing Codex reports for ${patchRef} (patch unchanged)` };
    }
    const spec = s.spec!;
    const roles = [...this.policy.baseVerifierRoles];
    if (spec.flags.ui) roles.push("exploratory_playwright");
    if (spec.flags.persistence) roles.push("persistence");
    if (spec.flags.security) roles.push("security");

    const results = await Promise.all(
      roles.map((role) =>
        this.guarded(`Codex ${role}`, this.policy.timeouts.codexRun, (sig) =>
          this.ports.codex.verify({ spec, role, patchRef, baseline: s.baseline!, acceptance: s.acceptance! }, sig),
        ),
      ),
    );
    s.codex = { patchRef, reports: results.map((r) => r.report) };
    const refs = await Promise.all(results.map((r) => this.store.artifact(s.unitId, `codex-${r.report.role}-run${s.factory.runs}`, r.report)));
    const over = this.spend(s, results.reduce((sum, r) => sum + r.costUsd, 0));
    if (over) return over;
    return { next: "CV6", note: `Codex roles: ${roles.join(", ")}`, refs };
  };

  private joinFindings: Handler = async (s) => {
    const patchRef = s.bundle!.patchRef;
    const existing = s.findingsPatchRef === patchRef ? s.findings : [];
    s.findings = joinFindings(s.codex.reports, existing, s.dismissedFingerprints, this.policy);
    s.findingsPatchRef = patchRef;
    for (const r of s.codex.reports) {
      for (const sc of r.proposedScenarios) {
        if (!s.scenarios.handled.includes(sc.id) && !s.scenarios.pending.some((p) => p.id === sc.id)) s.scenarios.pending.push(sc);
      }
    }
    const blocking = s.findings.filter(reviewable).length;
    return { next: "FD", note: `${s.findings.length} findings, ${blocking} blocking, ${s.scenarios.pending.length} proposed scenarios` };
  };

  private findingDecision: Handler = async (s) => {
    if (s.findings.some(reviewable)) return { next: "DR", note: "blocking finding" };
    if (s.scenarios.pending.length) return { next: "NR", note: "new acceptance scenario proposed" };
    return { next: "AG", note: "no blocking findings" };
  };

  // ─── DR / DC / RV: contest handling ────────────────────────────────────────

  private claudeReviewsFinding: Handler = async (s) => {
    const finding = s.findings.find(reviewable);
    if (!finding) {
      const accepted = s.findings.filter((f) => f.status === "accepted" && !f.sentToRepair);
      if (accepted.length) return this.toRepairFromFindings(s, accepted.map((f) => f.id));
      return { next: "FD", note: "no finding left to review" };
    }
    const recheck = finding.status === "upheld" ? (s.rechecks[finding.id] ?? null) : null;
    const { review, costUsd } = await this.guarded("Claude finding review", this.policy.timeouts.review, (sig) =>
      this.ports.factory.reviewFinding({ spec: s.spec!, bundle: s.bundle!, finding, recheck }, sig),
    );
    s.reviews[finding.id] = review;
    const ref = await this.store.artifact(s.unitId, `review-${finding.id}-${(s.contests[finding.id] ?? 0) + 1}`, review);
    const over = this.spend(s, costUsd);
    if (over) return over;

    if (review.verdict === "accept") {
      finding.status = "accepted";
      s.repair.pendingItems.push(codexItem(finding));
      // Review remaining blocking findings before repairing, so one repair covers them all.
      if (s.findings.some(reviewable)) return { next: "DR", note: `accepted ${finding.id}; reviewing next finding`, refs: [ref] };
      return this.toRepairFromFindings(s, [finding.id], ref);
    }
    finding.status = "contested";
    s.contests[finding.id] = (s.contests[finding.id] ?? 0) + 1;
    return { next: "DC", note: `Claude contests ${finding.id}`, refs: [ref] };
  };

  private toRepairFromFindings(s: UnitState, ids: string[], ref?: string): Step {
    const pending = new Set(s.repair.pendingItems.map(signatureOf));
    for (const f of s.findings) {
      const item: RepairItem = codexItem(f);
      if (f.status === "accepted" && !f.sentToRepair && !pending.has(signatureOf(item))) s.repair.pendingItems.push(item);
    }
    return { next: "BR", note: `accepted findings to repair: ${ids.join(", ")}`, refs: ref ? [ref] : undefined };
  }

  private priorContest: Handler = async (s) => {
    const contested = s.findings.find((f) => f.status === "contested")!;
    if (s.contests[contested.id] > this.policy.budgets.contestsPerFinding) {
      return this.escalate(s, {
        reason: "repeated_contest",
        from: "DC",
        summary: `Claude contested ${contested.id} again after an independent recheck upheld it`,
        findingIds: [contested.id],
      });
    }
    return { next: "RV", note: `first contest of ${contested.id}` };
  };

  private codexRecheck: Handler = async (s) => {
    const finding = s.findings.find((f) => f.status === "contested")!;
    const review = s.reviews[finding.id];
    // A fresh Codex run sees the finding and Claude's argument, not the earlier Codex context.
    const { result, costUsd } = await this.guarded("Codex recheck", this.policy.timeouts.codexRun, (sig) =>
      this.ports.codex.recheck({ spec: s.spec!, patchRef: s.bundle!.patchRef, finding, review }, sig),
    );
    s.rechecks[finding.id] = result;
    const ref = await this.store.artifact(s.unitId, `recheck-${finding.id}`, result);
    const over = this.spend(s, costUsd);
    if (over) return over;
    if (result.verdict === "upheld") {
      finding.status = "upheld";
      return { next: "DR", note: `recheck upheld ${finding.id}`, refs: [ref] };
    }
    finding.status = "withdrawn";
    return { next: "FD", note: `recheck withdrew ${finding.id}`, refs: [ref] };
  };

  // ─── NR / UB: proposed acceptance scenarios ────────────────────────────────

  private reviewScenario: Handler = async (s) => {
    const scenario = s.scenarios.pending.shift()!;
    s.scenarios.handled.push(scenario.id);
    const decision = await this.ports.humans.reviewScenario(s.spec!, scenario);
    const ref = await this.store.artifact(s.unitId, `scenario-${scenario.id}`, { scenario, decision });
    if (decision.verdict === "approved") {
      s.scenarios.approved = scenario;
      return { next: "UB", note: `scenario ${scenario.id} approved`, refs: [ref] };
    }
    const next = s.scenarios.pending.length ? "NR" : "AG";
    return { next, note: `scenario ${scenario.id} ${decision.verdict}`, refs: [ref] };
  };

  private updateBaseline: Handler = async (s) => {
    const scenario = s.scenarios.approved!;
    s.scenarios.approved = null;
    if (s.baselineUpdates >= this.policy.budgets.baselineUpdates) {
      return { next: "FD", note: `baseline update budget reached; ${scenario.id} logged as informational` };
    }
    // A baseline must describe legacy behavior. If the old build fails it, it is a new requirement, not a baseline.
    if (!(await this.ports.baseline.passesOnLegacy(s.spec!, scenario))) {
      return { next: "FD", note: `${scenario.id} fails on legacy build; logged as informational` };
    }
    s.baseline = await this.ports.baseline.addScenario(s.spec!, s.baseline!, scenario);
    s.baselineUpdates++;
    const ref = await this.store.artifact(s.unitId, `baseline-v${s.baseline.version}`, s.baseline);
    return { next: "FA", note: `baseline v${s.baseline.version} frozen with ${scenario.id}`, refs: [ref] };
  };

  // ─── AG / H / K / X ────────────────────────────────────────────────────────

  private acceptanceGate: Handler = async (s) => {
    const { verdict, reasons } = finalGate(s, this.policy);
    const ref = await this.store.artifact(s.unitId, `gate-run${s.factory.runs}`, { verdict, reasons });
    if (verdict === "pass") return { next: "K", note: "all required evidence passes", refs: [ref] };
    if (verdict === "policy_exception") {
      return { ...this.escalate(s, { reason: "policy_exception", from: "AG", summary: reasons.join("; "), findingIds: [] }), refs: [ref] };
    }
    s.status = "rejected";
    return { next: "X", note: `unsafe: ${reasons.join("; ")}`, refs: [ref] };
  };

  private humanReview: Handler = async (s) => {
    const c = s.escalation!;
    const decision = await this.ports.humans.decide(c, s);
    if (!c.allowed.includes(decision.kind)) {
      throw new Error(`human decision "${decision.kind}" not allowed for ${c.reason}; allowed: ${c.allowed.join(", ")}`);
    }
    const ref = await this.store.artifact(s.unitId, `decision-${s.trace.length}`, { escalation: c, decision });
    s.escalation = null;
    switch (decision.kind) {
      case "approve_difference":
        s.deviations.push(decision.deviationId);
        if (s.bundle) {
          // The approval covers what the case file showed: undocumented
          // differences get this deviation ID, unresolved risks are acknowledged.
          for (const d of s.bundle.knownBehavioralDifferences) {
            if (!d.deviationId || !s.deviations.includes(d.deviationId)) d.deviationId = decision.deviationId;
          }
          for (const r of s.bundle.unresolvedRisks) s.acknowledgedRisks.push(r.description);
        }
        for (const f of s.findings) {
          if (decision.dismissFindingIds.includes(f.id)) {
            f.status = "dismissed";
            s.dismissedFingerprints.push(f.fingerprint);
          }
        }
        // Approval clears one exception; the final gate still checks everything else.
        return { next: "AG", note: `approved deviation ${decision.deviationId}`, refs: [ref] };
      case "require_repair":
        s.repair.pendingItems = [...s.repair.pendingItems, ...decision.items];
        s.repair.extraGranted++;
        return { next: "BR", note: `human requires repair: ${decision.note}`, refs: [ref] };
      case "reject":
        s.status = "rejected";
        return { next: "X", note: `rejected: ${decision.note}`, refs: [ref] };
      case "suspend":
        s.status = "suspended";
        return { next: "X", note: `suspended: ${decision.note}`, refs: [ref] };
    }
  };

  private checkpoint: Handler = async (s) => {
    s.checkpointRef = await this.ports.repo.checkpoint(s.spec!, s.bundle!, `migration unit ${s.unitId}`);
    s.status = "completed";
    return { next: "DONE", note: `checkpointed at ${s.checkpointRef}` };
  };

  private terminal: Handler = async (s) => ({ next: s.node, note: "terminal" });
}
