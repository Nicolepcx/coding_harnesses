# The harness: lifecycle core and adapters

Pi owns the lifecycle of a migration unit. Claude Code builds, Codex verifies,
deterministic runners accept, and people decide only at `H` and `NR`. `src/` is
the programmatic core of that flowchart (contracts, gate engine, state machine);
`adapters/` connects it to `claude -p`, `codex exec`, the frozen checks, git and
people; `pi/` is the Pi front end. See the top-level README for how to run it.

```
npm ci
node sim/simulate.ts      # drives every flowchart path through the real lifecycle
npx tsc -p .              # type check
node run.ts RUN_DIR       # run (or resume) a unit; tools/start.sh wraps this
```

Node 22.18+ runs the TypeScript directly (type stripping), and so does Pi's extension loader.

## Files

| File | What it is |
|---|---|
| `src/contracts.ts` | Every cross-boundary message as one TypeBox schema: the TS type, Pi's validator, Claude's `--json-schema` and Codex's `--output-schema` |
| `src/policy.ts` | Budgets, timeouts, severity floors, required acceptance per risk, replanning rules. Nothing an agent can change |
| `src/state.ts` | Durable state of one unit; node IDs match the flowchart |
| `src/ports.ts` | Interfaces to Claude, Codex, acceptance runners, git and humans |
| `src/gates.ts` | Pure decision functions: evidence validation, acceptance evaluation, finding classification, repair routing, oscillation, final gate |
| `src/lifecycle.ts` | One handler per flowchart node; persists and audits every transition |
| `src/store.ts` | `state.json` (atomic), `audit.jsonl` (append-only), `artifacts/` |
| `config/policy.ts` | The policy this repository runs with, calibrated after a first real run |
| `adapters/` | `claude.ts` (factory and reviews), `codex.ts` (verifiers and rechecks), `acceptance.ts` (frozen checks in clean checkouts), `workspace.ts` (scope, baseline, git), `humans.ts` (case files), `exec.ts` (timeouts, OOM priority, cleanup) |
| `factory/` | Copied into each workspace: `CLAUDE.md`, subagents, the dual-compatibility skill, hooks and deny rules |
| `checks/` | `differential.py`, `inspect_store.py`, `run_playwright.sh`: the frozen checks, generic over a domain |
| `pi/migrate.ts` | Pi extension: start a unit, show status, answer an escalation |
| `sim/simulate.ts` | Scripted ports; asserts the exact node trace for 19 paths |

## The script, step by step

| Node | Handler | Calls | Decided by |
|---|---|---|---|
| `Q` → `S` | `defineScope` | `scope.define` | Inventory facts → risk floor, writable/forbidden/test paths, flags |
| `B` | `freezeBaseline` | `baseline.freeze` | Digests of frozen assets; acceptance is only valid for this digest |
| `CL` → `CLAUDE[C1]` | `runFactory` | `claude -p` (next step) | One headless factory run; Claude's internal loop C1…C11 |
| `CLAUDE[C5/C6/C7]` | `runFactory` | same | Re-entry point chosen by Pi: replan, re-implement, re-integrate |
| `EV` | `validateEvidence` | `repo.changedFiles` | Schema + claims vs. git diff, forbidden paths, unreported test changes |
| `ER` | `returnEvidenceDefect` | – | Evidence budget; back to C7 with the defect list |
| `FA` | `runFrozenAcceptance` | acceptance runner | Steps required for the effective risk (floor or higher) |
| `FG` | `frozenGate` | – | Re-derives pass/fail from step results; digest mismatch → `H` |
| `BR` | `boundedRepair` | – | Repair budget and oscillation check |
| `RT` | `routeRepair` | – | `differential`/`persistence` failure, wide failure or repeat after C6 → C5; otherwise C6 |
| `CV` | `launchCodex` | `codex exec` × roles, in parallel | Roles from policy plus unit flags; cached per patch |
| `CV6` | `joinFindings` | – | Dedupe; rule-based severity floor; blocking classification |
| `FD` | `findingDecision` | – | Blocking → `DR`; proposed scenario → `NR`; else `AG` |
| `DR` | `claudeReviewsFinding` | Claude review | Accept → repair; contest → `DC` |
| `DC` | `priorContest` | – | Second contest after an upheld recheck → `H` |
| `RV` | `codexRecheck` | fresh `codex exec` | Upheld → `DR`; withdrawn → `FD` |
| `NR` | `reviewScenario` | human | Approved → `UB` |
| `UB` | `updateBaseline` | baseline service | Must pass on the legacy build; new digest; back to `FA` |
| `AG` | `acceptanceGate` | – | Pass → `K`; undocumented difference or unresolved high risk → `H`; anything unsound → `X` |
| `H` | `humanReview` | human | Only decisions valid for the case are accepted |
| `K` | `checkpoint` | `repo.checkpoint` | Merge and record |

## Decisions the code makes that the flowchart leaves open

1. `DR` reviews all blocking findings before one repair, so a repair covers them together.
2. `RV` → withdrawn goes to `FD`, since there is nothing left for Claude to review.
3. `H` → approve goes to `AG`, not `K`. The approval covers the findings and differences the case file listed; it does not bypass the other gates.
4. `UB` only adds a scenario that passes on the legacy build, and has its own budget. Otherwise the scenario is logged as informational.
5. `BR` has an outer repair budget and an oscillation check, both escalating to `H`. Findings are compared by content (category and files), because Codex renumbers its findings in every run.
6. Any agent step can escalate on a stall (timeout) or the unit's cost budget.
7. A frozen-asset digest mismatch at `FG` escalates instead of becoming a repair, because Claude cannot repair tampering.
