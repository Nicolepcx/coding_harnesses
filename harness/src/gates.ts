/**
 * Gate engine. Pure functions only: given evidence and policy, return a
 * decision. No agent output is trusted here without a cross-check, and no
 * agent can change a threshold.
 */
import { Value } from "typebox/value";
import {
  EvidenceBundle as EvidenceBundleSchema,
  RISK_ORDER,
  SEVERITY_ORDER,
  type AcceptanceFailure,
  type AcceptanceResult,
  type AcceptanceStep,
  type CodexFinding,
  type CodexReport,
  type EvidenceBundle,
  type RepairItem,
  type RiskLevel,
  type Severity,
  type UnitSpec,
} from "./contracts.ts";
import type { Policy } from "./policy.ts";
import type { RepairRecord, TrackedFinding, UnitState } from "./state.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
export const matchesAny = (file: string, globs: string[]) => globs.some((g) => globToRegExp(g).test(file));

const maxOf = <T>(order: T[], a: T, b: T) => (order.indexOf(a) >= order.indexOf(b) ? a : b);
export const atLeast = <T>(order: T[], value: T, threshold: T) => order.indexOf(value) >= order.indexOf(threshold);

export function effectiveRisk(spec: UnitSpec, bundle: EvidenceBundle | null): RiskLevel {
  // The lead may raise risk, never lower it below Pi's floor.
  return bundle ? maxOf(RISK_ORDER, bundle.riskLevel, spec.riskFloor) : spec.riskFloor;
}

// ─── EV: evidence validation ─────────────────────────────────────────────────

/**
 * Returns a list of evidence defects. Empty list = valid.
 * Claims in the bundle are checked against git, not trusted.
 */
export function validateEvidence(bundle: unknown, diffFiles: string[], spec: UnitSpec): string[] {
  if (!Value.Check(EvidenceBundleSchema, bundle)) {
    return [...Value.Errors(EvidenceBundleSchema, bundle)].slice(0, 10).map((e) => `schema: ${e.instancePath || "/"} ${e.message}`);
  }
  const b = bundle as EvidenceBundle;
  const defects: string[] = [];
  const claimed = new Set(b.changedFiles);
  const actual = new Set(diffFiles);

  for (const f of actual) if (!claimed.has(f)) defects.push(`unreported change: ${f}`);
  for (const f of claimed) if (!actual.has(f)) defects.push(`claimed change not in diff: ${f}`);

  for (const f of diffFiles) {
    if (matchesAny(f, spec.forbiddenPaths)) defects.push(`forbidden path changed: ${f}`);
    else if (!matchesAny(f, spec.writablePaths) && !matchesAny(f, spec.testPaths)) defects.push(`change outside unit scope: ${f}`);
  }

  // Every changed test file must be declared as added or modified (with a reason).
  const declaredTests = new Set([...b.testsAdded, ...b.testsModified.map((t) => t.path)]);
  for (const f of diffFiles) {
    if (matchesAny(f, spec.testPaths) && !declaredTests.has(f)) defects.push(`test change not reported: ${f}`);
  }

  if (b.unitId !== spec.unitId) defects.push(`bundle is for unit ${b.unitId}, expected ${spec.unitId}`);
  if (b.outcome === "candidate" && b.testsExecuted.length === 0) defects.push("no internal test execution reported");
  return defects;
}

// ─── FG: frozen acceptance ───────────────────────────────────────────────────

export function requiredSteps(risk: RiskLevel, policy: Policy): AcceptanceStep[] {
  return policy.requiredAcceptance[risk];
}

/** Re-derives pass/fail from the runner's step results; does not trust `passed`. */
export function evaluateAcceptance(
  result: AcceptanceResult,
  risk: RiskLevel,
  baselineDigest: string,
  patchRef: string,
  policy: Policy,
): { passed: boolean; integrity: boolean; failures: AcceptanceFailure[] } {
  const failures: AcceptanceFailure[] = [];
  const integrity = result.baselineDigest === baselineDigest && result.patchRef === patchRef;
  if (!integrity) {
    failures.push({ step: "digests", check: "result-binding", detail: "result does not match current baseline digest or patch", files: [] });
  }
  for (const step of requiredSteps(risk, policy)) {
    const r = result.steps.find((s) => s.step === step);
    if (!r || r.status === "skipped") {
      failures.push({ step, check: "required-step", detail: `required step ${step} did not run`, files: [] });
      continue;
    }
    if (r.status === "fail") failures.push(...r.failures);
    if (step === "mutation") {
      const threshold = policy.mutationThreshold[risk];
      if (threshold !== null && (r.metric ?? 0) < threshold) {
        failures.push({ step, check: "mutation-threshold", detail: `score ${r.metric} below ${threshold}`, files: [] });
      }
    }
  }
  const digestStep = result.steps.find((s) => s.step === "digests");
  const tampered = !integrity || digestStep?.status === "fail";
  return { passed: failures.length === 0, integrity: !tampered, failures };
}

// ─── CV6: join and classify Codex findings ───────────────────────────────────

export const fingerprint = (f: CodexFinding) => `${f.category}|${[...f.files].sort().join(",")}`;

export function classifyFinding(f: CodexFinding, policy: Policy): { effectiveSeverity: Severity; blocking: boolean } {
  const effectiveSeverity = maxOf(SEVERITY_ORDER, f.severity, policy.severityFloor[f.category]);
  const severe = atLeast(SEVERITY_ORDER, effectiveSeverity, policy.blockingSeverity);
  const evidenced = f.reproduced || policy.blockWithoutReproduction.includes(f.category);
  return { effectiveSeverity, blocking: severe && evidenced };
}

/**
 * Joins reports into tracked findings. Findings already tracked for the same
 * patch keep their status, so a cached CV pass does not reopen contests.
 */
export function joinFindings(
  reports: CodexReport[],
  existing: TrackedFinding[],
  dismissed: string[],
  policy: Policy,
): TrackedFinding[] {
  const byPrint = new Map(existing.map((f) => [f.fingerprint, f]));
  for (const report of reports) {
    for (const f of report.findings) {
      const fp = fingerprint(f);
      if (byPrint.has(fp)) {
        // Keep the more severe description if two verifiers found the same thing.
        const prev = byPrint.get(fp)!;
        if (atLeast(SEVERITY_ORDER, f.severity, prev.severity) && prev.status === "open") {
          byPrint.set(fp, { ...prev, ...f, id: prev.id, ...classifyFinding(f, policy) });
        }
        continue;
      }
      byPrint.set(fp, {
        ...f,
        role: report.role,
        fingerprint: fp,
        ...classifyFinding(f, policy),
        status: dismissed.includes(fp) ? "dismissed" : "open",
        sentToRepair: false,
      });
    }
  }
  return [...byPrint.values()];
}

export const reviewable = (f: TrackedFinding) => f.blocking && (f.status === "open" || f.status === "upheld");

// ─── BR / RT: bounded repair and routing ─────────────────────────────────────

export const signatureOf = (i: RepairItem) => `${i.source}:${i.ref}`;

export function acceptanceRepairItems(failures: AcceptanceFailure[]): RepairItem[] {
  return failures.map((f) => ({ source: "acceptance", ref: `${f.step}:${f.check}`, summary: f.detail, files: f.files }));
}

/**
 * Oscillation: a failure that disappeared in the previous repair round comes
 * back now. That is a fix being undone, not progress.
 */
export function detectOscillation(history: RepairRecord[], signatures: string[]): string[] {
  if (history.length < 2) return [];
  const prev = new Set(history[history.length - 1].signatures);
  const earlier = new Set(history.slice(0, -1).flatMap((h) => h.signatures));
  return signatures.filter((s) => earlier.has(s) && !prev.has(s));
}

/** RT: does this failure need replanning (C5) or only implementation (C6)? */
export function decideRepairEntry(
  items: RepairItem[],
  history: RepairRecord[],
  policy: Policy,
): { entry: "plan" | "implement"; reason: string } {
  const steps = items.map((i) => i.ref.split(":")[0]);
  const forcing = steps.find((s) => policy.replan.stepsThatForceReplan.includes(s as AcceptanceStep));
  if (forcing) return { entry: "plan", reason: `${forcing} failure means behavior was misread` };

  const files = new Set(items.flatMap((i) => i.files));
  if (files.size > policy.replan.maxFilesForLocalRepair) {
    return { entry: "plan", reason: `${files.size} files affected, more than a local repair` };
  }
  const last = history[history.length - 1];
  if (policy.replan.replanOnRepeatFailure && last?.entry === "implement") {
    const repeated = items.map(signatureOf).filter((s) => last.signatures.includes(s));
    if (repeated.length) return { entry: "plan", reason: `repeat failure after implementation repair: ${repeated.join(", ")}` };
  }
  return { entry: "implement", reason: "local defect" };
}

export function repairAllowedPaths(items: RepairItem[], spec: UnitSpec, entry: "plan" | "implement"): string[] {
  if (entry === "plan" || items.some((i) => i.files.length === 0)) return spec.writablePaths;
  const files = [...new Set(items.flatMap((i) => i.files))];
  return files.filter((f) => matchesAny(f, spec.writablePaths) || matchesAny(f, spec.testPaths));
}

// ─── AG: final acceptance gate ───────────────────────────────────────────────

export function finalGate(
  state: UnitState,
  policy: Policy,
): { verdict: "pass" | "policy_exception" | "unsafe"; reasons: string[] } {
  const { spec, bundle, baseline, acceptance } = state;
  if (!spec || !bundle || !baseline || !acceptance) return { verdict: "unsafe", reasons: ["missing evidence"] };

  const unsafe: string[] = [];
  const exceptions: string[] = [];
  const risk = effectiveRisk(spec, bundle);

  const acc = evaluateAcceptance(acceptance, risk, baseline.digest, bundle.patchRef, policy);
  if (!acc.integrity) unsafe.push("acceptance not bound to current baseline and patch");
  else if (!acc.passed) unsafe.push("frozen acceptance not passing");

  for (const f of state.findings) {
    if (!reviewable(f) && f.status !== "accepted" && f.status !== "contested") continue;
    if (!f.blocking) continue;
    if (f.category === "security" && f.effectiveSeverity === "critical") unsafe.push(`open critical security finding ${f.id}`);
    else unsafe.push(`open blocking finding ${f.id}`);
  }

  for (const d of bundle.knownBehavioralDifferences) {
    if (!d.deviationId || !state.deviations.includes(d.deviationId)) {
      exceptions.push(`behavioral difference without approved deviation: ${d.description}`);
    }
  }
  for (const r of bundle.unresolvedRisks) {
    if (atLeast(SEVERITY_ORDER, r.severity, policy.blockingSeverity) && !state.acknowledgedRisks.includes(r.description)) {
      exceptions.push(`unresolved ${r.severity} risk: ${r.description}`);
    }
  }

  if (unsafe.length) return { verdict: "unsafe", reasons: unsafe };
  if (exceptions.length) return { verdict: "policy_exception", reasons: exceptions };
  return { verdict: "pass", reasons: [] };
}
