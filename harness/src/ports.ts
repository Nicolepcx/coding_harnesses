/**
 * Ports: everything the lifecycle needs from the outside world.
 *
 * The lifecycle never shells out itself. Real adapters (claude -p, codex exec,
 * the Playwright/differential runner, git, the human review UI in Pi) implement
 * these interfaces; the simulator implements them with scripted mocks.
 */
import type {
  AcceptanceResult,
  AcceptanceStep,
  BaselineManifest,
  CodexFinding,
  CodexReport,
  EvidenceBundle,
  FactoryEntry,
  FindingReview,
  HumanDecision,
  ProposedScenario,
  RecheckResult,
  RepairAssignment,
  ScenarioDecision,
  UnitSpec,
  VerifierRole,
} from "./contracts.ts";
import type { EscalationCase, UnitState } from "./state.ts";

/** S — deterministic scope: packages, paths, risk floor from inventory signals. */
export interface ScopeService {
  define(unitId: string): Promise<UnitSpec>;
}

/** B / UB — frozen baseline and acceptance assets. */
export interface BaselineService {
  freeze(spec: UnitSpec): Promise<BaselineManifest>;
  /** Replays a proposed scenario against the legacy (Py2) build. */
  passesOnLegacy(spec: UnitSpec, scenario: ProposedScenario): Promise<boolean>;
  addScenario(spec: UnitSpec, baseline: BaselineManifest, scenario: ProposedScenario): Promise<BaselineManifest>;
}

export interface FactoryRequest {
  spec: UnitSpec;
  baseline: BaselineManifest;
  entry: FactoryEntry;
  runNumber: number;
  internalRetryBudget: number;
  discoveryRef: string | null;
  planRef: string | null;
  repair: RepairAssignment | null;
  evidenceDefects: string[];
  previousPatchRef: string | null;
}

/** CL … C11 — one headless Claude Code factory run, plus DR reviews. */
export interface ClaudeFactory {
  run(req: FactoryRequest, signal: AbortSignal): Promise<{ bundle: EvidenceBundle; costUsd: number }>;
  reviewFinding(
    req: { spec: UnitSpec; bundle: EvidenceBundle; finding: CodexFinding; recheck: RecheckResult | null },
    signal: AbortSignal,
  ): Promise<{ review: FindingReview; costUsd: number }>;
}

/** CV1 … CV5 / RV — independent Codex runs, launched by Pi. */
export interface CodexVerifier {
  verify(
    req: { spec: UnitSpec; role: VerifierRole; patchRef: string; baseline: BaselineManifest; acceptance: AcceptanceResult },
    signal: AbortSignal,
  ): Promise<{ report: CodexReport; costUsd: number }>;
  recheck(
    req: { spec: UnitSpec; patchRef: string; finding: CodexFinding; review: FindingReview },
    signal: AbortSignal,
  ): Promise<{ result: RecheckResult; costUsd: number }>;
}

/** FA1 … FA6 — deterministic runners; no agent in this path. */
export interface AcceptanceRunner {
  run(
    req: { spec: UnitSpec; baseline: BaselineManifest; patchRef: string; requiredSteps: AcceptanceStep[] },
    signal: AbortSignal,
  ): Promise<AcceptanceResult>;
}

/** Git facts and the final checkpoint (K). */
export interface RepoService {
  /** Files actually changed by the patch, from git, not from the agent. */
  changedFiles(spec: UnitSpec, patchRef: string): Promise<string[]>;
  checkpoint(spec: UnitSpec, bundle: EvidenceBundle, summary: string): Promise<string>;
}

/** H / NR — the only places a person decides. */
export interface HumanGate {
  decide(c: EscalationCase, state: Readonly<UnitState>): Promise<HumanDecision>;
  reviewScenario(spec: UnitSpec, scenario: ProposedScenario): Promise<ScenarioDecision>;
}

export interface Ports {
  scope: ScopeService;
  baseline: BaselineService;
  factory: ClaudeFactory;
  codex: CodexVerifier;
  acceptance: AcceptanceRunner;
  repo: RepoService;
  humans: HumanGate;
}
