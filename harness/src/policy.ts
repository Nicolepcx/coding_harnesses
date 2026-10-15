/**
 * Migration policy.
 *
 * Everything the gate engine decides with comes from here, not from an agent.
 * The core is generic; config/policy.ts is the policy this repository runs with and
 * calibrates thresholds and budgets.
 */
import type { AcceptanceStep, CodexFinding, RiskLevel, Severity, VerifierRole } from "./contracts.ts";

export interface Budgets {
  /** C10: internal review/test iterations inside one factory run. Passed to Claude, checked by Pi. */
  internalRetries: number;
  /** BR: bounded repair assignments per unit before escalation. */
  repairs: number;
  /** ER: evidence-defect returns per unit before escalation. */
  evidenceDefects: number;
  /** DC: contests per finding before escalation ("prior contest?"). */
  contestsPerFinding: number;
  /** UB: frozen-baseline updates per unit (stops endless scenario proposals). */
  baselineUpdates: number;
  /** Total spend per unit across Claude and Codex runs. */
  costUsd: number;
}

export interface Timeouts {
  /** Wall-clock limits per adapter call, in ms. A timeout is a stall → H. */
  factoryRun: number;
  codexRun: number;
  acceptance: number;
  review: number;
}

export interface Policy {
  budgets: Budgets;
  timeouts: Timeouts;

  /** Findings at or above this effective severity block acceptance. */
  blockingSeverity: Severity;
  /**
   * Rule-based severity floor per finding category. Codex may raise severity,
   * never lower it below the floor. This keeps "severity" from being a hidden
   * pass/fail switch in the verifier's hands.
   */
  severityFloor: Record<CodexFinding["category"], Severity>;
  /** Categories that block even when Codex could not reproduce them. */
  blockWithoutReproduction: CodexFinding["category"][];

  /** Acceptance steps that must pass, per risk level. */
  requiredAcceptance: Record<RiskLevel, AcceptanceStep[]>;
  /** Minimum mutation score on changed code, per risk level (null = not required). */
  mutationThreshold: Record<RiskLevel, number | null>;

  /** Which Codex verifier roles always run; conditional roles come from unit flags. */
  baseVerifierRoles: VerifierRole[];

  replan: {
    /** Acceptance steps whose failure means the plan misread behavior. */
    stepsThatForceReplan: AcceptanceStep[];
    /** More failing files than this, spread across scopes, means the plan is wrong. */
    maxFilesForLocalRepair: number;
    /** A check that fails again after an implementation-level repair forces replanning. */
    replanOnRepeatFailure: boolean;
  };
}

export const defaultPolicy: Policy = {
  budgets: {
    internalRetries: 3,
    repairs: 4,
    evidenceDefects: 2,
    contestsPerFinding: 1,
    baselineUpdates: 2,
    costUsd: 40,
  },
  timeouts: {
    factoryRun: 90 * 60_000,
    codexRun: 30 * 60_000,
    acceptance: 45 * 60_000,
    review: 10 * 60_000,
  },
  blockingSeverity: "high",
  severityFloor: {
    defect: "medium",
    test_gap: "low",
    suspicious_test_change: "high",
    behavioral_difference: "high",
    persistence: "high",
    security: "high",
  },
  blockWithoutReproduction: ["suspicious_test_change", "security"],
  requiredAcceptance: {
    low: ["digests", "unit_integration", "differential"],
    medium: ["digests", "unit_integration", "playwright", "differential"],
    high: ["digests", "unit_integration", "playwright", "differential", "persistence", "mutation"],
    critical: ["digests", "unit_integration", "playwright", "differential", "persistence", "mutation"],
  },
  mutationThreshold: { low: null, medium: null, high: 0.7, critical: 0.8 },
  baseVerifierRoles: ["code_review", "test_gap"],
  replan: {
    stepsThatForceReplan: ["differential", "persistence"],
    maxFilesForLocalRepair: 8,
    replanOnRepeatFailure: true,
  },
};
