/**
 * Flowchart simulator.
 *
 * Drives the real lifecycle and gate engine with scripted mock ports. Each
 * scenario states the exact node trace the flowchart predicts; the run fails
 * if the lifecycle takes any other path.
 *
 *   node sim/simulate.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
  AcceptanceResult,
  AcceptanceStep,
  BaselineManifest,
  CodexFinding,
  CodexReport,
  EvidenceBundle,
  FindingReview,
  HumanDecision,
  ProposedScenario,
  RecheckResult,
  ScenarioDecision,
  VerifierRole,
} from "../src/contracts.ts";
import { classifyFinding, effectiveRisk, globToRegExp } from "../src/gates.ts";
import { MigrationLifecycle } from "../src/lifecycle.ts";
import { defaultPolicy, type Policy } from "../src/policy.ts";
import type { UnitSpec } from "../src/contracts.ts";
import type { FactoryRequest, Ports } from "../src/ports.ts";
import { MemoryStore } from "../src/store.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const PKG = "shop.core.search";
const VIEWS = `src/${PKG}/views.py`;
const UTILS = `src/${PKG}/utils.py`;
const TEST = `src/${PKG}/tests/test_views.py`;

// A medium-risk package with browser views (the scope service's output, fixed here).
const spec: UnitSpec = {
  unitId: PKG,
  packages: [PKG],
  writablePaths: [`src/${PKG}/**`],
  forbiddenPaths: ["acceptance/**", "baseline/**", ".claude/**"],
  testPaths: [`src/${PKG}/**/tests/**`, `src/${PKG}/**/test_*.py`],
  riskFloor: "medium",
  riskSignals: ["5 transitive dependents", "active customer package"],
  flags: { persistence: false, ui: true, security: false },
  constraints: ["Migrate, do not improve.", "The trunk must stay dual-compatible."],
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

function bundle(patchRef: string, over: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    unitId: PKG,
    outcome: "candidate",
    riskLevel: "low", // the lead tries "low"; Pi's floor keeps it at medium
    topology: { discovery: ["repository_archaeologist", "test_archaeologist", "dependency_specialist", "ui_specialist"], implementation: [{ agent: "impl-a", scope: [VIEWS] }] },
    migrationScope: "Port search views to dual-compatible Py2/Py3",
    affectedComponents: ["search views"],
    assumptions: ["query strings are ASCII-safe after decoding"],
    changedFiles: [VIEWS, TEST],
    testsAdded: [TEST],
    testsModified: [],
    testsExecuted: [{ command: "bin/test -s shop.core.search", passed: 41, failed: 0 }],
    knownBehavioralDifferences: [],
    unresolvedRisks: [],
    internalIterations: 1,
    patchRef,
    discoveryRef: "artifacts/discovery.json",
    planRef: "artifacts/plan.json",
    ...over,
  };
}

type Fail = { step: AcceptanceStep; check: string; files?: string[] };
const acceptance = (fails: Fail[] = []) => (req: { baseline: BaselineManifest; patchRef: string; requiredSteps: AcceptanceStep[] }): AcceptanceResult => ({
  baselineDigest: req.baseline.digest,
  patchRef: req.patchRef,
  steps: req.requiredSteps.map((step) => {
    const f = fails.filter((x) => x.step === step);
    return {
      step,
      status: f.length ? "fail" : "pass",
      failures: f.map((x) => ({ step, check: x.check, detail: `${x.check} failed`, files: x.files ?? [VIEWS] })),
      metric: step === "mutation" ? 0.9 : null,
      artifactRef: null,
    };
  }),
  passed: fails.length === 0,
});

const finding = (id: string, over: Partial<CodexFinding> = {}): CodexFinding => ({
  id,
  category: "defect",
  severity: "high",
  summary: `${id}: pagination off by one under Py3 integer division`,
  evidence: "views.py:88 uses / where Py2 floored",
  files: [VIEWS],
  reproduced: true,
  ...over,
});

const scenarioProposal: ProposedScenario = {
  id: "SC-search-umlaut",
  title: "Search with umlaut in query",
  rationale: "No frozen scenario covers non-ASCII queries",
  steps: ["open /search", "type 'Zürich'", "submit"],
  expected: "results list shows 3 positions in Zürich",
};

// ─── scripted ports ──────────────────────────────────────────────────────────

interface Script {
  factory: ((req: FactoryRequest) => EvidenceBundle | Promise<never>)[];
  factoryCost?: number;
  diff?: Record<string, string[]>;
  acceptance: (((req: Parameters<ReturnType<typeof acceptance>>[0]) => AcceptanceResult) | "crash")[];
  codex?: (role: VerifierRole, patchRef: string) => Omit<CodexReport, "role">;
  reviews?: FindingReview["verdict"][];
  rechecks?: RecheckResult["verdict"][];
  decisions?: HumanDecision[];
  scenarioDecisions?: ScenarioDecision["verdict"][];
  legacyPasses?: boolean;
}

interface Calls {
  entries: string[];
  codexRuns: number;
  acceptanceRuns: number;
  escalations: string[];
}

function makePorts(script: Script, calls: Calls): Ports {
  const take = <T>(arr: T[] | undefined, what: string): T => {
    const v = arr?.shift();
    if (v === undefined) throw new Error(`script exhausted: ${what}`);
    return v;
  };
  return {
    scope: { define: async () => spec },
    baseline: {
      freeze: async () => ({ unitId: PKG, version: 1, frozenAt: "t0", assets: [], digest: sha("v1") }),
      passesOnLegacy: async () => script.legacyPasses ?? true,
      addScenario: async (_s, b, sc) => ({
        ...b,
        version: b.version + 1,
        assets: [...b.assets, { path: `acceptance/playwright/${sc.id}.spec.ts`, sha256: sha(sc.id), kind: "playwright" }],
        digest: sha(`v${b.version + 1}`),
      }),
    },
    factory: {
      run: async (req) => {
        calls.entries.push(req.entry);
        const b = await take(script.factory, "factory.run")(req);
        return { bundle: b, costUsd: script.factoryCost ?? 3 };
      },
      reviewFinding: async (req) => ({
        review: { findingId: req.finding.id, verdict: take(script.reviews, "reviewFinding"), argument: "Py2 also rounds down here" },
        costUsd: 0.5,
      }),
    },
    codex: {
      verify: async (req) => {
        calls.codexRuns++;
        const r = script.codex?.(req.role, req.patchRef) ?? { testsSelected: [], findings: [], proposedScenarios: [], recommendation: "accept" as const };
        return { report: { role: req.role, ...r }, costUsd: 1 };
      },
      recheck: async (req) => ({
        result: { findingId: req.finding.id, verdict: take(script.rechecks, "recheck"), reasoning: "reproduced on clean checkout" },
        costUsd: 1,
      }),
    },
    acceptance: {
      run: async (req) => {
        calls.acceptanceRuns++;
        const next = take(script.acceptance, "acceptance.run");
        if (next === "crash") throw new Error("acceptance runner crashed (container OOM)");
        return next(req);
      },
    },
    repo: {
      changedFiles: async (_s, patchRef) => script.diff?.[patchRef] ?? [VIEWS, TEST],
      checkpoint: async (_s, b) => `merge:${b.patchRef}`,
    },
    humans: {
      decide: async (c) => {
        calls.escalations.push(c.reason);
        return take(script.decisions, `human decision for ${c.reason}`);
      },
      reviewScenario: async (_s, sc) => ({ scenarioId: sc.id, verdict: take(script.scenarioDecisions, "scenario review"), note: "" }),
    },
  };
}

// ─── scenarios ───────────────────────────────────────────────────────────────

const HEAD = ["Q", "S", "B", "CL", "CLAUDE[C1]"];
const ACCEPT = ["EV", "FA", "FG", "CV", "CV6", "FD", "AG", "K", "DONE"];
const ok = (p: string) => () => bundle(p);
const pass = acceptance();

interface Case {
  name: string;
  script: Script;
  expect: string[];
  status: "completed" | "rejected" | "suspended";
  policy?: Partial<Policy>;
  check?: (c: Calls, s: Awaited<ReturnType<MigrationLifecycle["run"]>>, store: MemoryStore) => void;
  resume?: boolean;
}

const humanRepair: HumanDecision = {
  kind: "require_repair",
  items: [{ source: "human", ref: "F1", summary: "Codex is right: Py2 floored here", files: [VIEWS] }],
  note: "recheck reproduced it twice",
};

const cases: Case[] = [
  {
    name: "Happy path",
    script: { factory: [ok("p1")], acceptance: [pass] },
    expect: [...HEAD, ...ACCEPT],
    status: "completed",
    check: (c, s) => {
      assert.equal(effectiveRisk(s.spec!, s.bundle), "medium", "lead cannot lower risk below Pi's floor");
      assert.equal(c.codexRuns, 3, "code_review + test_gap + exploratory_playwright (UI flag)");
    },
  },
  {
    name: "EV → ER: unreported change returns to C7",
    script: {
      factory: [ok("p1"), () => bundle("p2", { changedFiles: [VIEWS, UTILS, TEST] })],
      diff: { p1: [VIEWS, UTILS, TEST], p2: [VIEWS, UTILS, TEST] },
      acceptance: [pass],
    },
    expect: [...HEAD, "EV", "ER", "CLAUDE[C7]", ...ACCEPT],
    status: "completed",
    check: (c) => assert.deepEqual(c.entries, ["classify", "integrate"]),
  },
  {
    name: "FG fails locally → BR → RT → C6",
    script: { factory: [ok("p1"), ok("p2")], acceptance: [acceptance([{ step: "unit_integration", check: "test_paging" }]), pass] },
    expect: [...HEAD, "EV", "FA", "FG", "BR", "RT", "CLAUDE[C6]", ...ACCEPT],
    status: "completed",
  },
  {
    name: "FG differential failure → replan at C5",
    script: { factory: [ok("p1"), ok("p2")], acceptance: [acceptance([{ step: "differential", check: "GET /search?q=a" }]), pass] },
    expect: [...HEAD, "EV", "FA", "FG", "BR", "RT", "CLAUDE[C5]", ...ACCEPT],
    status: "completed",
  },
  {
    name: "Repeat failure after C6 repair → replan at C5",
    script: {
      factory: [ok("p1"), ok("p2"), ok("p3")],
      acceptance: [acceptance([{ step: "unit_integration", check: "test_paging" }]), acceptance([{ step: "unit_integration", check: "test_paging" }]), pass],
    },
    expect: [...HEAD, "EV", "FA", "FG", "BR", "RT", "CLAUDE[C6]", "EV", "FA", "FG", "BR", "RT", "CLAUDE[C5]", ...ACCEPT],
    status: "completed",
  },
  {
    name: "Blocking Codex finding accepted → BR → C6",
    script: {
      factory: [ok("p1"), ok("p2")],
      acceptance: [pass, pass],
      codex: (role, p) => ({ testsSelected: [], findings: role === "code_review" && p === "p1" ? [finding("F1")] : [], proposedScenarios: [], recommendation: "accept" }),
      reviews: ["accept"],
    },
    expect: [...HEAD, "EV", "FA", "FG", "CV", "CV6", "FD", "DR", "BR", "RT", "CLAUDE[C6]", ...ACCEPT],
    status: "completed",
  },
  {
    name: "Contest → recheck upheld → second contest → H → bounded repair",
    script: {
      factory: [ok("p1"), ok("p2")],
      acceptance: [pass, pass],
      codex: (role, p) => ({ testsSelected: [], findings: role === "code_review" && p === "p1" ? [finding("F1")] : [], proposedScenarios: [], recommendation: "repair" }),
      reviews: ["contest", "contest"],
      rechecks: ["upheld"],
      decisions: [humanRepair],
    },
    expect: [...HEAD, "EV", "FA", "FG", "CV", "CV6", "FD", "DR", "DC", "RV", "DR", "DC", "H", "BR", "RT", "CLAUDE[C6]", ...ACCEPT],
    status: "completed",
    check: (c) => assert.deepEqual(c.escalations, ["repeated_contest"]),
  },
  {
    name: "Contest → recheck withdraws finding → AG",
    script: {
      factory: [ok("p1")],
      acceptance: [pass],
      codex: (role) => ({ testsSelected: [], findings: role === "code_review" ? [finding("F1")] : [], proposedScenarios: [], recommendation: "repair" }),
      reviews: ["contest"],
      rechecks: ["withdrawn"],
    },
    expect: [...HEAD, "EV", "FA", "FG", "CV", "CV6", "FD", "DR", "DC", "RV", "FD", "AG", "K", "DONE"],
    status: "completed",
  },
  {
    name: "Codex cannot lower severity: 'low' suspicious test change still blocks",
    script: {
      factory: [ok("p1"), ok("p2")],
      acceptance: [pass, pass],
      codex: (role, p) => ({
        testsSelected: [],
        findings: role === "test_gap" && p === "p1" ? [finding("F2", { category: "suspicious_test_change", severity: "low", reproduced: false, files: [TEST] })] : [],
        proposedScenarios: [],
        recommendation: "accept",
      }),
      reviews: ["accept"],
    },
    expect: [...HEAD, "EV", "FA", "FG", "CV", "CV6", "FD", "DR", "BR", "RT", "CLAUDE[C6]", ...ACCEPT],
    status: "completed",
  },
  {
    name: "New scenario approved → UB → FA (Codex reused for same patch)",
    script: {
      factory: [ok("p1")],
      acceptance: [pass, pass],
      codex: (role) => ({ testsSelected: [], findings: [], proposedScenarios: role === "exploratory_playwright" ? [scenarioProposal] : [], recommendation: "accept" }),
      scenarioDecisions: ["approved"],
    },
    expect: [...HEAD, "EV", "FA", "FG", "CV", "CV6", "FD", "NR", "UB", "FA", "FG", "CV", "CV6", "FD", "AG", "K", "DONE"],
    status: "completed",
    check: (c, s) => {
      assert.equal(c.codexRuns, 3, "Codex runs once per patch, not again after a baseline update");
      assert.equal(s.baseline!.version, 2);
      assert.equal(s.acceptance!.baselineDigest, s.baseline!.digest, "acceptance re-ran against the new baseline");
    },
  },
  {
    name: "Proposed scenario fails on legacy → informational, not baseline",
    script: {
      factory: [ok("p1")],
      acceptance: [pass],
      codex: (role) => ({ testsSelected: [], findings: [], proposedScenarios: role === "exploratory_playwright" ? [scenarioProposal] : [], recommendation: "accept" }),
      scenarioDecisions: ["approved"],
      legacyPasses: false,
    },
    expect: [...HEAD, "EV", "FA", "FG", "CV", "CV6", "FD", "NR", "UB", "FD", "AG", "K", "DONE"],
    status: "completed",
    check: (_c, s) => assert.equal(s.baseline!.version, 1),
  },
  {
    name: "Undocumented behavioral difference → AG policy exception → H approves → AG",
    script: {
      factory: [() => bundle("p1", { knownBehavioralDifferences: [{ description: "CSV export now UTF-8 instead of latin-1", deviationId: null }] })],
      acceptance: [pass],
      decisions: [{ kind: "approve_difference", deviationId: "DEV-031", dismissFindingIds: [], note: "customers asked for UTF-8" }],
    },
    expect: [...HEAD, "EV", "FA", "FG", "CV", "CV6", "FD", "AG", "H", "AG", "K", "DONE"],
    status: "completed",
    check: (c, s) => {
      assert.deepEqual(c.escalations, ["policy_exception"]);
      assert.deepEqual(s.deviations, ["DEV-031"]);
    },
  },
  {
    name: "C10 internal budget exhausted → H → reject",
    script: {
      factory: [() => bundle("p1", { outcome: "internal_budget_exhausted", internalIterations: 3 })],
      acceptance: [],
      decisions: [{ kind: "reject", note: "needs a human-led port" }],
    },
    expect: [...HEAD, "H", "X"],
    status: "rejected",
  },
  {
    name: "Repair budget exhausted → H → suspend",
    script: {
      factory: [ok("p1"), ok("p2"), ok("p3"), ok("p4"), ok("p5")],
      acceptance: ["c1", "c2", "c3", "c4", "c5"].map((c) => acceptance([{ step: "unit_integration", check: c }])),
      decisions: [{ kind: "suspend", note: "park until core wave lands" }],
    },
    expect: [
      ...HEAD, "EV", "FA", "FG",
      ...["BR", "RT", "CLAUDE[C6]", "EV", "FA", "FG"],
      ...["BR", "RT", "CLAUDE[C6]", "EV", "FA", "FG"],
      ...["BR", "RT", "CLAUDE[C6]", "EV", "FA", "FG"],
      ...["BR", "RT", "CLAUDE[C6]", "EV", "FA", "FG"],
      "BR", "H", "X",
    ],
    status: "suspended",
    check: (c) => assert.deepEqual(c.escalations, ["repair_budget_exhausted"]),
  },
  {
    name: "Oscillation: fixed failure returns → H",
    script: {
      factory: [ok("p1"), ok("p2"), ok("p3")],
      acceptance: [
        acceptance([{ step: "unit_integration", check: "a" }]),
        acceptance([{ step: "unit_integration", check: "b" }]),
        acceptance([{ step: "unit_integration", check: "a" }]),
      ],
      decisions: [{ kind: "reject", note: "fixes undo each other" }],
    },
    expect: [...HEAD, "EV", "FA", "FG", "BR", "RT", "CLAUDE[C6]", "EV", "FA", "FG", "BR", "RT", "CLAUDE[C6]", "EV", "FA", "FG", "BR", "H", "X"],
    status: "rejected",
    check: (c) => assert.deepEqual(c.escalations, ["oscillation"]),
  },
  {
    name: "Forbidden path (frozen acceptance asset) → ER until budget → H",
    script: {
      factory: [1, 2, 3].map((n) => () => bundle(`p${n}`, { changedFiles: [VIEWS, "acceptance/playwright/search.spec.ts"] })),
      diff: Object.fromEntries([1, 2, 3].map((n) => [`p${n}`, [VIEWS, "acceptance/playwright/search.spec.ts"]])),
      acceptance: [],
      decisions: [{ kind: "reject", note: "agent keeps editing frozen scenarios" }],
    },
    expect: [...HEAD, "EV", "ER", "CLAUDE[C7]", "EV", "ER", "CLAUDE[C7]", "EV", "ER", "H", "X"],
    status: "rejected",
    check: (c) => assert.deepEqual(c.escalations, ["evidence_budget_exhausted"]),
  },
  {
    name: "Stalled factory run → H → suspend",
    policy: { timeouts: { ...defaultPolicy.timeouts, factoryRun: 50 } },
    script: {
      factory: [() => new Promise<never>(() => {})],
      acceptance: [],
      decisions: [{ kind: "suspend", note: "investigate hung session" }],
    },
    expect: [...HEAD, "H", "X"],
    status: "suspended",
    check: (c) => assert.deepEqual(c.escalations, ["stalled"]),
  },
  {
    name: "Cost budget exhausted → H → reject",
    script: { factory: [ok("p1")], factoryCost: 55, acceptance: [], decisions: [{ kind: "reject", note: "too expensive for this unit" }] },
    expect: [...HEAD, "H", "X"],
    status: "rejected",
    check: (c) => assert.deepEqual(c.escalations, ["cost_budget_exhausted"]),
  },
  {
    name: "Crash in acceptance runner → resume from FA without re-running Claude",
    resume: true,
    script: { factory: [ok("p1")], acceptance: ["crash", pass] },
    expect: [...HEAD, ...ACCEPT],
    status: "completed",
    check: (c) => {
      assert.deepEqual(c.entries, ["classify"], "factory ran once");
      assert.equal(c.acceptanceRuns, 2);
    },
  },
];

// ─── gate unit checks ────────────────────────────────────────────────────────

function gateChecks() {
  const p = defaultPolicy;
  assert.equal(classifyFinding(finding("x", { category: "behavioral_difference", severity: "low" }), p).blocking, true);
  assert.equal(classifyFinding(finding("x", { category: "defect", severity: "high", reproduced: false }), p).blocking, false);
  assert.equal(classifyFinding(finding("x", { category: "security", severity: "medium", reproduced: false }), p).blocking, true);
  assert.equal(classifyFinding(finding("x", { category: "test_gap", severity: "medium" }), p).blocking, false);
  assert.ok(globToRegExp("src/pkg/**/tests/**").test("src/pkg/a/b/tests/test_x.py"));
  assert.ok(globToRegExp("src/pkg/**").test("src/pkg/views.py"));
  assert.ok(!globToRegExp("src/pkg/**").test("src/other/views.py"));
  assert.ok(globToRegExp("versions*.cfg").test("versions-py3.cfg"));
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  gateChecks();
  console.log("gate unit checks          PASS\n");
  let failed = 0;
  for (const c of cases) {
    const calls: Calls = { entries: [], codexRuns: 0, acceptanceRuns: 0, escalations: [] };
    const store = new MemoryStore();
    const policy = { ...defaultPolicy, ...c.policy };
    const s = c.script;
    const script: Script = {
      ...s,
      factory: [...s.factory],
      acceptance: [...s.acceptance],
      reviews: s.reviews && [...s.reviews],
      rechecks: s.rechecks && [...s.rechecks],
      decisions: s.decisions && [...s.decisions],
      scenarioDecisions: s.scenarioDecisions && [...s.scenarioDecisions],
    };
    const ports = makePorts(script, calls);
    let state;
    try {
      try {
        state = await new MigrationLifecycle(ports, policy, store).run(PKG);
      } catch (e) {
        if (!c.resume) throw e;
        // A new Pi process picks the unit up from the persisted state.
        state = await new MigrationLifecycle(ports, policy, store).run(PKG);
      }
      assert.deepEqual(state.trace, c.expect, "trace differs from flowchart");
      assert.equal(state.status, c.status);
      assert.equal(store.events.length, state.trace.length - 1, "one audit event per transition");
      c.check?.(calls, state, store);
      console.log(`PASS  ${c.name}\n      ${state.trace.join(" → ")}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${c.name}\n      ${(e as Error).message}`);
      if (state) console.log(`      got: ${state.trace.join(" → ")}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} scenarios follow the flowchart`);
  process.exit(failed ? 1 : 0);
}

main();
