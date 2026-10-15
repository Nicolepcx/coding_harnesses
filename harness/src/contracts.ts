/**
 * Evidence contracts.
 *
 * Every message that crosses a harness boundary is defined once here as a
 * TypeBox schema. The same definition is used as:
 *   - the TypeScript type (Static<...>)
 *   - Pi's runtime validator (Value.Check / Value.Errors)
 *   - Claude Code's   --json-schema   (structured output of the factory)
 *   - Codex's         --output-schema (structured output of each verifier run)
 *
 * All objects are closed (additionalProperties: false) and every property is
 * required; optional values are expressed as `| null`. That is what Codex's
 * strict structured output expects, and it keeps "missing" and "empty"
 * distinguishable for the gate engine.
 */
import { Type, type Static, type TSchema } from "typebox";

const Obj = <P extends Record<string, TSchema>>(props: P) =>
  Type.Object(props, { additionalProperties: false });
const Nullable = <S extends TSchema>(s: S) => Type.Union([s, Type.Null()]);
const Enum = <const V extends string[]>(...values: V) => Type.Enum(values);

// ─── Shared vocabulary ────────────────────────────────────────────────────────

export const RiskLevel = Enum("low", "medium", "high", "critical");
export type RiskLevel = Static<typeof RiskLevel>;
export const RISK_ORDER: RiskLevel[] = ["low", "medium", "high", "critical"];

export const Severity = Enum("info", "low", "medium", "high", "critical");
export type Severity = Static<typeof Severity>;
export const SEVERITY_ORDER: Severity[] = ["info", "low", "medium", "high", "critical"];

/** Where the Claude factory is (re-)entered. Mirrors C1 / C5 / C6 / C7. */
export const FactoryEntry = Enum("classify", "plan", "implement", "integrate");
export type FactoryEntry = Static<typeof FactoryEntry>;

export const VerifierRole = Enum("code_review", "test_gap", "exploratory_playwright", "persistence", "security");
export type VerifierRole = Static<typeof VerifierRole>;

export const AcceptanceStep = Enum("digests", "unit_integration", "playwright", "differential", "persistence", "mutation");
export type AcceptanceStep = Static<typeof AcceptanceStep>;

// ─── S: unit spec (Pi defines scope and constraints) ─────────────────────────

export const UnitSpec = Obj({
  unitId: Type.String(),
  packages: Type.Array(Type.String()),
  /** Globs the implementation agents may write to. */
  writablePaths: Type.Array(Type.String()),
  /** Globs nobody in the Claude tree may touch (frozen tests, baselines, pins). */
  forbiddenPaths: Type.Array(Type.String()),
  /** Globs that count as test files, for the "test changes reported" check. */
  testPaths: Type.Array(Type.String()),
  /** Deterministic minimum risk, derived by Pi from inventory signals. */
  riskFloor: RiskLevel,
  riskSignals: Type.Array(Type.String()),
  /** Which conditional specialists / verifiers apply. */
  flags: Obj({ persistence: Type.Boolean(), ui: Type.Boolean(), security: Type.Boolean() }),
  /** Plain-language constraints handed to every agent, e.g. "dual-compatible Py2/Py3". */
  constraints: Type.Array(Type.String()),
});
export type UnitSpec = Static<typeof UnitSpec>;

// ─── B: frozen baseline and acceptance assets ────────────────────────────────

export const BaselineAsset = Obj({
  path: Type.String(),
  sha256: Type.String(),
  kind: Enum("unit_integration", "playwright", "differential", "persistence"),
});
export type BaselineAsset = Static<typeof BaselineAsset>;

export const BaselineManifest = Obj({
  unitId: Type.String(),
  version: Type.Integer(),
  frozenAt: Type.String(),
  assets: Type.Array(BaselineAsset),
  /** Hash over all asset hashes. Acceptance results are only valid for this digest. */
  digest: Type.String(),
});
export type BaselineManifest = Static<typeof BaselineManifest>;

// ─── C11: Claude factory output (evidence bundle) ────────────────────────────

export const EvidenceBundle = Obj({
  unitId: Type.String(),
  /** "internal_budget_exhausted" is the C10 → No exit. */
  outcome: Enum("candidate", "internal_budget_exhausted"),
  riskLevel: RiskLevel,
  topology: Obj({
    discovery: Type.Array(Type.String()),
    implementation: Type.Array(Obj({ agent: Type.String(), scope: Type.Array(Type.String()) })),
  }),
  migrationScope: Type.String(),
  affectedComponents: Type.Array(Type.String()),
  assumptions: Type.Array(Type.String()),
  /** Claims. Pi checks these against the real diff and runner output. */
  changedFiles: Type.Array(Type.String()),
  testsAdded: Type.Array(Type.String()),
  testsModified: Type.Array(Obj({ path: Type.String(), reason: Type.String() })),
  testsExecuted: Type.Array(Obj({ command: Type.String(), passed: Type.Integer(), failed: Type.Integer() })),
  knownBehavioralDifferences: Type.Array(
    Obj({ description: Type.String(), /** Must reference the human-owned deviation register. */ deviationId: Nullable(Type.String()) }),
  ),
  unresolvedRisks: Type.Array(Obj({ description: Type.String(), severity: Severity })),
  internalIterations: Type.Integer(),
  /** Commit on the unit branch that holds the integrated patch. */
  patchRef: Type.String(),
  /** Persisted discovery findings and plan, so re-entry at C5/C6/C7 can reuse them. */
  discoveryRef: Nullable(Type.String()),
  planRef: Nullable(Type.String()),
});
export type EvidenceBundle = Static<typeof EvidenceBundle>;

// ─── FA: frozen deterministic acceptance ─────────────────────────────────────

export const AcceptanceFailure = Obj({
  step: AcceptanceStep,
  check: Type.String(),
  detail: Type.String(),
  files: Type.Array(Type.String()),
});
export type AcceptanceFailure = Static<typeof AcceptanceFailure>;

export const AcceptanceResult = Obj({
  baselineDigest: Type.String(),
  patchRef: Type.String(),
  steps: Type.Array(
    Obj({
      step: AcceptanceStep,
      status: Enum("pass", "fail", "skipped"),
      failures: Type.Array(AcceptanceFailure),
      /** e.g. mutation score; null when the step has no metric. */
      metric: Nullable(Type.Number()),
      artifactRef: Nullable(Type.String()),
    }),
  ),
  passed: Type.Boolean(),
});
export type AcceptanceResult = Static<typeof AcceptanceResult>;

// ─── CV: Codex exploratory verification ──────────────────────────────────────

export const CodexFinding = Obj({
  id: Type.String(),
  category: Enum("defect", "test_gap", "suspicious_test_change", "behavioral_difference", "persistence", "security"),
  /** Codex's proposal. Pi applies a rule-based floor on top (see gates.ts). */
  severity: Severity,
  summary: Type.String(),
  evidence: Type.String(),
  files: Type.Array(Type.String()),
  reproduced: Type.Boolean(),
});
export type CodexFinding = Static<typeof CodexFinding>;

export const ProposedScenario = Obj({
  id: Type.String(),
  title: Type.String(),
  rationale: Type.String(),
  steps: Type.Array(Type.String()),
  expected: Type.String(),
});
export type ProposedScenario = Static<typeof ProposedScenario>;

export const CodexReport = Obj({
  role: VerifierRole,
  testsSelected: Type.Array(Type.String()),
  findings: Type.Array(CodexFinding),
  proposedScenarios: Type.Array(ProposedScenario),
  recommendation: Enum("accept", "repair", "escalate"),
});
export type CodexReport = Static<typeof CodexReport>;

// ─── DR / RV: contest and recheck ────────────────────────────────────────────

export const FindingReview = Obj({
  findingId: Type.String(),
  verdict: Enum("accept", "contest"),
  argument: Type.String(),
});
export type FindingReview = Static<typeof FindingReview>;

export const RecheckResult = Obj({
  findingId: Type.String(),
  verdict: Enum("upheld", "withdrawn"),
  reasoning: Type.String(),
});
export type RecheckResult = Static<typeof RecheckResult>;

// ─── BR: bounded repair assignment ───────────────────────────────────────────

export const RepairItem = Obj({
  source: Enum("acceptance", "codex", "human"),
  ref: Type.String(),
  summary: Type.String(),
  files: Type.Array(Type.String()),
});
export type RepairItem = Static<typeof RepairItem>;

export const RepairAssignment = Obj({
  id: Type.String(),
  unitId: Type.String(),
  entry: Enum("plan", "implement"),
  items: Type.Array(RepairItem),
  /** Narrower than the unit's writablePaths when the failures are local. */
  allowedPaths: Type.Array(Type.String()),
  repairNumber: Type.Integer(),
  repairsRemaining: Type.Integer(),
});
export type RepairAssignment = Static<typeof RepairAssignment>;

// ─── H / NR: human decisions ─────────────────────────────────────────────────

export const EscalationReason = Enum(
  "internal_budget_exhausted",
  "repair_budget_exhausted",
  "evidence_budget_exhausted",
  "oscillation",
  "repeated_contest",
  "policy_exception",
  "stalled",
  "cost_budget_exhausted",
  "baseline_integrity",
);
export type EscalationReason = Static<typeof EscalationReason>;

export const HumanDecision = Type.Union([
  Obj({ kind: Type.Literal("approve_difference"), deviationId: Type.String(), dismissFindingIds: Type.Array(Type.String()), note: Type.String() }),
  Obj({ kind: Type.Literal("require_repair"), items: Type.Array(RepairItem), note: Type.String() }),
  Obj({ kind: Type.Literal("reject"), note: Type.String() }),
  Obj({ kind: Type.Literal("suspend"), note: Type.String() }),
]);
export type HumanDecision = Static<typeof HumanDecision>;

export const ScenarioDecision = Obj({
  scenarioId: Type.String(),
  verdict: Enum("approved", "rejected", "informational"),
  note: Type.String(),
});
export type ScenarioDecision = Static<typeof ScenarioDecision>;
