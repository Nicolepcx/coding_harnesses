/**
 * Where everything of one harness run lives, and which domain it migrates.
 * One directory per run, so runs never share state and the whole audit trail
 * can be archived with one tar.
 *
 *   RUN/workspace/   git repo the Claude factory works in (its only writable tree)
 *   RUN/baseline/    the harness's own frozen copies: legacy build, data file, goldens
 *   RUN/state/       Pi's durable state.json, audit.jsonl, artifacts/
 *   RUN/reports/     raw acceptance reports per run
 *   RUN/scratch/     clean checkouts for acceptance and for each Codex verifier
 *   RUN/decisions/   escalations waiting for a person, and their answers
 *   RUN/logs/        raw Claude and Codex transcripts
 */
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(HARNESS, "..");

/** domains/<name>/domain.json: everything the generic harness needs to know about one codebase. */
export interface Domain {
  name: string;
  unitId: string;
  title: string;
  /** Items copied from domains/<name>/app into the workspace. */
  copy: string[];
  /** The production data file, relative to the app. */
  dataFile: string;
  modules: { cli: string; web?: string; store: string };
  storeOpen: string;
  /** CLI steps that write the data file, for the persistence round trip. */
  storeWrite: string[][];
  /** CLI commands that write the data file (blocked by the bash guard on frozen paths). */
  writeCommands?: string[];
  riskPatterns: { persistentClasses: string; pickleCalls: string; encodingHotspots: string };
  constraints: string[];
  currentPlanPrompt: string;
}

export interface Layout {
  run: string;
  workspace: string;
  baseline: string;
  state: string;
  reports: string;
  scratch: string;
  decisions: string;
  logs: string;
  repo: string;
  harness: string;
  checks: string;
  factory: string;
  /** domains/<name> */
  domainDir: string;
  /** domains/<name>/app: the legacy build */
  app: string;
  domain: Domain;
  py2: string;
  py3: string;
  pwNodeModules: string;
}

export function layoutFor(runDir: string, env: NodeJS.ProcessEnv = process.env): Layout {
  const run = resolve(runDir);
  const domainDir = resolve(env.HARNESS_DOMAIN ?? join(REPO, "domains", "invoicing"));
  const domain = JSON.parse(readFileSync(join(domainDir, "domain.json"), "utf8")) as Domain;
  return {
    run,
    workspace: join(run, "workspace"),
    baseline: join(run, "baseline"),
    state: join(run, "state"),
    reports: join(run, "reports"),
    scratch: join(run, "scratch"),
    decisions: join(run, "decisions"),
    logs: join(run, "logs"),
    repo: REPO,
    harness: HARNESS,
    checks: join(HARNESS, "checks"),
    factory: join(HARNESS, "factory"),
    domainDir,
    app: join(domainDir, "app"),
    domain,
    py2: env.PY2 ?? "python2.7",
    py3: env.PY3 ?? "python3.12",
    pwNodeModules: env.PW_NODE_MODULES ?? join(HARNESS, "node_modules"),
  };
}

export async function ensureDirs(l: Layout): Promise<void> {
  for (const d of [l.run, l.baseline, l.state, l.reports, l.scratch, l.decisions, l.logs]) {
    await mkdir(d, { recursive: true });
  }
}
