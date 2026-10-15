/**
 * The policy this repository runs with. Everything the gate engine decides
 * comes from here, never from an agent.
 *
 * Calibrated after a first real run (see the README):
 *  - Persistence findings never rank below "high": silent data changes are the
 *    most expensive failure of a migration, so they always block.
 *  - Behavior differences rank at least "medium". With a floor of "high", every
 *    edge case the verifiers found (an error message worded differently, the
 *    last digit of a float sum) blocked, and the verifiers always find another.
 *    Now a difference blocks when the verifier itself rates it high; the rest is
 *    reported and goes to the final gate as information.
 *  - No mutation step (no mutation tooling installed).
 */
import { defaultPolicy, type Policy } from "../src/policy.ts";

const steps = ["digests", "unit_integration", "playwright", "differential", "persistence"] as const;

export const policy: Policy = {
  ...defaultPolicy,
  budgets: {
    ...defaultPolicy.budgets,
    repairs: Number(process.env.HARNESS_REPAIRS ?? 3),
    costUsd: Number(process.env.HARNESS_BUDGET_USD ?? 60),
  },
  timeouts: {
    factoryRun: 120 * 60_000,
    codexRun: 40 * 60_000,
    acceptance: 30 * 60_000,
    review: 15 * 60_000,
  },
  severityFloor: {
    ...defaultPolicy.severityFloor,
    persistence: "high",
    behavioral_difference: "medium",
  },
  requiredAcceptance: {
    low: ["digests", "unit_integration", "differential"],
    medium: ["digests", "unit_integration", "playwright", "differential"],
    high: [...steps],
    critical: [...steps],
  },
  mutationThreshold: { low: null, medium: null, high: null, critical: null },
};
