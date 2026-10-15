/**
 * Durable state of one migration unit.
 *
 * Pi persists this after every transition. It is the only state that survives
 * a crash: the Claude and Codex loops are stateless from Pi's point of view and
 * are re-entered from here.
 */
import type {
  AcceptanceResult,
  BaselineManifest,
  CodexFinding,
  CodexReport,
  EscalationReason,
  EvidenceBundle,
  FactoryEntry,
  FindingReview,
  HumanDecision,
  ProposedScenario,
  RecheckResult,
  RepairAssignment,
  RepairItem,
  Severity,
  UnitSpec,
  VerifierRole,
} from "./contracts.ts";

/** Node IDs match the flowchart. CLAUDE is the factory subgraph (C1…C11). */
export type NodeId =
  | "Q" | "S" | "B" | "CL" | "CLAUDE"
  | "EV" | "ER" | "FA" | "FG" | "BR" | "RT"
  | "CV" | "CV6" | "FD" | "DR" | "DC" | "RV" | "NR" | "UB"
  | "AG" | "H" | "K" | "X" | "DONE";

export const TERMINAL: NodeId[] = ["DONE", "X"];

/** Factory entry point → flowchart node it re-enters. */
export const ENTRY_NODE: Record<FactoryEntry, string> = {
  classify: "C1",
  plan: "C5",
  implement: "C6",
  integrate: "C7",
};

export type FindingStatus = "open" | "accepted" | "contested" | "upheld" | "withdrawn" | "dismissed";

export interface TrackedFinding extends CodexFinding {
  role: VerifierRole;
  fingerprint: string;
  effectiveSeverity: Severity;
  blocking: boolean;
  status: FindingStatus;
  /** Set once the accepted finding has been handed to a repair assignment. */
  sentToRepair: boolean;
}

export interface EscalationCase {
  reason: EscalationReason;
  from: NodeId;
  summary: string;
  findingIds: string[];
  allowed: HumanDecision["kind"][];
}

export interface RepairRecord {
  number: number;
  entry: "plan" | "implement";
  signatures: string[];
}

export interface UnitState {
  unitId: string;
  node: NodeId;
  status: "running" | "completed" | "rejected" | "suspended";
  trace: string[];

  spec: UnitSpec | null;
  baseline: BaselineManifest | null;

  factory: {
    entry: FactoryEntry;
    runs: number;
    discoveryRef: string | null;
    planRef: string | null;
  };
  bundle: EvidenceBundle | null;
  evidenceDefects: string[];
  evidenceDefectReturns: number;

  acceptance: AcceptanceResult | null;

  codex: { patchRef: string | null; reports: CodexReport[] };
  findings: TrackedFinding[];
  /** Findings joined for this patch (so a cached CV pass keeps their statuses). */
  findingsPatchRef: string | null;
  contests: Record<string, number>;
  /** Latest Claude review and Codex recheck per finding, passed on verbatim. */
  reviews: Record<string, FindingReview>;
  rechecks: Record<string, RecheckResult>;

  scenarios: { pending: ProposedScenario[]; handled: string[]; approved: ProposedScenario | null };
  baselineUpdates: number;

  repair: {
    pendingItems: RepairItem[];
    current: RepairAssignment | null;
    count: number;
    extraGranted: number;
    history: RepairRecord[];
  };

  escalation: EscalationCase | null;
  /** Deviation-register IDs a human approved for this unit. */
  deviations: string[];
  /** Unresolved risks a human explicitly accepted at H. */
  acknowledgedRisks: string[];
  dismissedFingerprints: string[];

  costUsd: number;
  checkpointRef: string | null;
  updatedAt: string;
}

export function initialState(unitId: string): UnitState {
  return {
    unitId,
    node: "Q",
    status: "running",
    trace: [],
    spec: null,
    baseline: null,
    factory: { entry: "classify", runs: 0, discoveryRef: null, planRef: null },
    bundle: null,
    evidenceDefects: [],
    evidenceDefectReturns: 0,
    acceptance: null,
    codex: { patchRef: null, reports: [] },
    findings: [],
    findingsPatchRef: null,
    contests: {},
    reviews: {},
    rechecks: {},
    scenarios: { pending: [], handled: [], approved: null },
    baselineUpdates: 0,
    repair: { pendingItems: [], current: null, count: 0, extraGranted: 0, history: [] },
    escalation: null,
    deviations: [],
    acknowledgedRisks: [],
    dismissedFingerprints: [],
    costUsd: 0,
    checkpointRef: null,
    updatedAt: new Date().toISOString(),
  };
}
