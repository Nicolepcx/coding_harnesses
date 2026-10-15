/**
 * Workspace, scope (S), frozen baseline (B) and git facts (EV, K).
 *
 * Everything here is deterministic: no agent decides the scope, the risk floor,
 * the acceptance assets or which files a patch really changed.
 */
import { chmod, copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { BaselineAsset, BaselineManifest, EvidenceBundle, ProposedScenario, UnitSpec } from "../src/contracts.ts";
import type { BaselineService, RepoService, ScopeService } from "../src/ports.ts";
import { exec, must, sha256, sha256File } from "./exec.ts";
import type { Layout } from "./layout.ts";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Pi harness",
  GIT_AUTHOR_EMAIL: "harness@demo.local",
  GIT_COMMITTER_NAME: "Pi harness",
  GIT_COMMITTER_EMAIL: "harness@demo.local",
};
export const git = (l: Layout, ...args: string[]) => must("git", ["-C", l.workspace, ...args], { env: GIT_ENV });

const noPyc = (src: string) => !src.endsWith(".pyc") && !src.includes("__pycache__");

/** Copies the legacy app into a fresh workspace and the harness's own baseline copy. */
export async function prepareWorkspace(l: Layout): Promise<void> {
  if (existsSync(join(l.workspace, ".git"))) return; // resume: never rebuild a workspace
  const legacy = l.app;
  await mkdir(l.workspace, { recursive: true });
  for (const item of l.domain.copy) {
    await cp(join(legacy, item), join(l.workspace, item), { recursive: true, filter: noPyc });
  }
  // Claude factory config: CLAUDE.md, agents, skills, hooks, settings.
  await cp(join(l.factory, "CLAUDE.md"), join(l.workspace, "CLAUDE.md"));
  await cp(join(l.factory, ".claude"), join(l.workspace, ".claude"), { recursive: true, filter: noPyc });
  // The original sources, read-only reference for discovery and internal testing.
  await cp(join(legacy, "src"), join(l.workspace, ".pi", "legacy", "src"), { recursive: true, filter: noPyc });
  await writeFile(
    join(l.workspace, ".gitignore"),
    ["*.pyc", "__pycache__/", ".factory/", ".pi/hooks.jsonl", "test-results/", ""].join("\n"),
  );
  // The harness's own copy of the legacy build: the oracle no agent can touch.
  await cp(join(legacy, "src"), join(l.baseline, "legacy", "src"), { recursive: true, filter: noPyc });
  await cp(join(legacy, "tests"), join(l.baseline, "legacy", "tests"), { recursive: true, filter: noPyc });
  await git(l, "init", "-q");
  await git(l, "add", "-A");
  await git(l, "commit", "-qm", "legacy baseline (Python 2.7)");
}

// ─── S: scope ────────────────────────────────────────────────────────────────

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p, suffix)));
    else if (e.name.endsWith(suffix)) out.push(p);
  }
  return out;
}

export class WorkspaceScope implements ScopeService {
  private readonly l: Layout;
  constructor(l: Layout) {
    this.l = l;
  }

  async define(unitId: string): Promise<UnitSpec> {
    const src = join(this.l.workspace, "src");
    const packages = (await readdir(src, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    let persistent = 0;
    let encoding = 0;
    let pickles = 0;
    const rx = this.l.domain.riskPatterns;
    const count = (text: string, pattern: string) => (text.match(new RegExp(pattern, "g")) ?? []).length;
    for (const f of await listFiles(src, ".py")) {
      const text = await readFile(f, "utf8");
      persistent += count(text, rx.persistentClasses);
      encoding += count(text, rx.encodingHotspots);
      pickles += count(text, rx.pickleCalls);
    }
    // Inventory facts → risk floor. The Claude lead may raise it, never lower it.
    const signals: string[] = [];
    if (persistent) signals.push(`${persistent} persistent classes in a pickle store written by Python 2`);
    if (pickles) signals.push(`${pickles} pickle call sites`);
    if (encoding > 10) signals.push(`${encoding} encoding hotspots`);
    const riskFloor = persistent ? "high" : encoding > 10 ? "medium" : "low";

    const spec: UnitSpec = {
      unitId,
      packages,
      writablePaths: ["src/**", "tests/**"],
      forbiddenPaths: [
        "acceptance/**", `${this.l.domain.dataFile.split("/")[0]}/**`, ".pi/**", ".claude/**", "CLAUDE.md", ".gitignore",
        ...this.l.domain.copy.filter((c) => !["src", "tests"].includes(c) && c !== this.l.domain.dataFile.split("/")[0]),
      ],
      testPaths: ["tests/**"],
      riskFloor,
      riskSignals: signals,
      flags: { persistence: persistent > 0, ui: Boolean(this.l.domain.modules.web), security: false },
      constraints: this.l.domain.constraints,
    };
    await this.writeUnitFiles(spec);
    return spec;
  }

  private async writeUnitFiles(spec: UnitSpec) {
    const pi = join(this.l.workspace, ".pi");
    await mkdir(pi, { recursive: true });
    await writeFile(
      join(pi, "claim.json"),
      JSON.stringify({
        writable: [...spec.writablePaths, ".factory/**"],
        forbidden: spec.forbiddenPaths,
        // CLI commands that write the data file they are given: the bash guard blocks them on frozen paths.
        writeCommands: (this.l.domain.writeCommands ?? []).map((command) => ({ module: this.l.domain.modules.cli, command })),
      }, null, 2) + "\n",
    );
    const md = [
      `Unit **${spec.unitId}**: packages ${spec.packages.join(", ")}.`,
      ``,
      `- Risk floor (set by Pi from inventory facts, you may raise it, not lower it): **${spec.riskFloor}**`,
      ...spec.riskSignals.map((s) => `  - ${s}`),
      `- You may write: ${spec.writablePaths.join(", ")} and your notes in .factory/ (not versioned).`,
      `- Frozen: ${spec.forbiddenPaths.join(", ")}`,
      `- Original Python 2 sources for comparison: .pi/legacy/src (read-only)`,
      `- Production data file written by Python 2: ${this.l.domain.dataFile} (read-only; work on /tmp copies)`,
      `- CLI: \`PYTHONPATH=src python -m ${this.l.domain.modules.cli} COMMAND /tmp/copy ARGS\`` +
        (this.l.domain.modules.web ? `; web: \`PYTHONPATH=src python -m ${this.l.domain.modules.web} /tmp/copy PORT\`` : ""),
      `- Frozen acceptance and how to run it yourself: acceptance/README.md`,
      ``,
      `Constraints:`,
      ...spec.constraints.map((c) => `- ${c}`),
      ``,
    ].join("\n");
    await writeFile(join(pi, "unit.md"), md);
  }
}

// ─── B: frozen baseline ──────────────────────────────────────────────────────

const readme = (data: string) => `# Frozen acceptance (read-only)

Recorded by the harness on the legacy build (Python 2.7) before any change.
The harness runs exactly these checks again in a clean checkout of your commit.
Run them yourself as often as you like; never edit anything in this directory.

Differential (CLI + web, generated by coverage from the legacy data):

    python3 acceptance/bin/differential.py --domain acceptance/domain.json compare \\
      --python python3.12 --app . --fixture ${data} \\
      --scenarios acceptance/differential/scenarios.json --golden acceptance/differential/golden.json
    # and the same with --python python2.7

Persistence (the port reads the Python 2 file, keeps the content when it writes,
and the legacy build still reads what the port wrote, with the same types):

    python3 acceptance/bin/differential.py --domain acceptance/domain.json store \\
      --python python3.12 --app . --fixture ${data} --golden acceptance/differential/store.json \\
      --legacy-python python2.7 --legacy-app .pi/legacy

Unit tests (at least the number of tests in acceptance/unit_tests.json, on both):

    PYTHONPATH=src python2.7 -m unittest discover -s tests
    PYTHONPATH=src python3.12 -m unittest discover -s tests

Playwright (web UI):

    acceptance/run_playwright.sh python3.12 . acceptance/playwright ${data} acceptance/domain.json
`;

export class FrozenBaseline implements BaselineService {
  private readonly l: Layout;
  constructor(l: Layout) {
    this.l = l;
  }

  private get manifestPath() {
    return join(this.l.baseline, "manifest.json");
  }

  async freeze(spec: UnitSpec): Promise<BaselineManifest> {
    if (existsSync(this.manifestPath)) return JSON.parse(await readFile(this.manifestPath, "utf8"));
    const l = this.l;
    const data = l.domain.dataFile;
    const b = (p: string) => join(l.baseline, p);
    for (const d of ["acceptance/differential", "acceptance/bin", "acceptance/playwright", dirname(data)]) {
      await mkdir(b(d), { recursive: true });
    }
    await copyFile(join(l.app, data), b(data));
    await copyFile(join(l.domainDir, "domain.json"), b("acceptance/domain.json"));
    await copyFile(join(l.checks, "differential.py"), b("acceptance/bin/differential.py"));
    await copyFile(join(l.checks, "inspect_store.py"), b("acceptance/bin/inspect_store.py"));
    await copyFile(join(l.checks, "run_playwright.sh"), b("acceptance/run_playwright.sh"));
    const specs = existsSync(join(l.domainDir, "playwright"))
      ? (await readdir(join(l.domainDir, "playwright"))).filter((f) => f.endsWith(".ts") || f === "package.json")
      : [];
    for (const f of specs) await copyFile(join(l.domainDir, "playwright", f), b(`acceptance/playwright/${f}`));

    const legacyApp = b("legacy");
    const diff = [b("acceptance/bin/differential.py"), "--domain", b("acceptance/domain.json")];
    await must("python3", [...diff, "generate", "--python", l.py2, "--app", legacyApp, "--fixture", b(data),
      "--generator", join(l.domainDir, "scenarios.py"), "--out", b("acceptance/differential/scenarios.json")]);
    await must("python3", [...diff, "record", "--python", l.py2, "--app", legacyApp, "--fixture", b(data),
      "--scenarios", b("acceptance/differential/scenarios.json"), "--out", b("acceptance/differential/golden.json"),
      "--store-out", b("acceptance/differential/store.json")]);
    // Unit tests: the legacy suite's size is the floor; a port may add tests, not drop them.
    const t = await exec(l.py2, ["-m", "unittest", "discover", "-s", "tests"], {
      cwd: legacyApp, env: { PYTHONPATH: join(legacyApp, "src"), PYTHONDONTWRITEBYTECODE: "1" },
    });
    const ran = Number((t.stderr.match(/Ran (\d+) tests?/) ?? [])[1] ?? 0);
    if (t.code !== 0 || !ran) throw new Error(`legacy unit tests do not pass on ${l.py2}: ${t.stderr.slice(-400)}`);
    await writeFile(b("acceptance/unit_tests.json"), JSON.stringify({ minTests: ran, recordedWith: l.py2 }, null, 1) + "\n");
    await writeFile(b("acceptance/README.md"), readme(data));

    // Mirror into the workspace (read-only for the factory) and hash.
    const assetList: { path: string; kind: BaselineAsset["kind"] }[] = [
      { path: "acceptance/domain.json", kind: "differential" },
      { path: "acceptance/differential/scenarios.json", kind: "differential" },
      { path: "acceptance/differential/golden.json", kind: "differential" },
      { path: "acceptance/bin/differential.py", kind: "differential" },
      { path: "acceptance/bin/inspect_store.py", kind: "persistence" },
      { path: "acceptance/differential/store.json", kind: "persistence" },
      { path: data, kind: "persistence" },
      { path: "acceptance/unit_tests.json", kind: "unit_integration" },
      { path: "acceptance/run_playwright.sh", kind: "playwright" },
      ...specs.map((f) => ({ path: `acceptance/playwright/${f}`, kind: "playwright" as const })),
    ];
    const assets: BaselineAsset[] = [];
    for (const a of assetList) {
      const target = join(l.workspace, a.path);
      await mkdir(dirname(target), { recursive: true });
      if (a.path !== data) await copyFile(b(a.path), target);
      assets.push({ path: a.path, kind: a.kind, sha256: await sha256File(b(a.path)) });
    }
    await copyFile(b("acceptance/README.md"), join(l.workspace, "acceptance/README.md"));
    for (const x of ["acceptance/run_playwright.sh", "acceptance/bin/differential.py"]) {
      await chmod(join(l.workspace, x), 0o755);
      await chmod(b(x), 0o755);
    }
    const workspaceFixture = await sha256File(join(l.workspace, data));
    if (workspaceFixture !== assets.find((a) => a.path === data)!.sha256) {
      throw new Error(`workspace ${data} differs from the legacy data file`);
    }
    const digest = sha256(assets.map((a) => `${a.path}:${a.sha256}`).sort().join("\n"));
    const manifest: BaselineManifest = { unitId: spec.unitId, version: 1, frozenAt: new Date().toISOString(), assets, digest };
    await writeFile(this.manifestPath, JSON.stringify(manifest, null, 1) + "\n");

    await git(l, "add", "-A");
    await git(l, "commit", "-qm", "harness: unit spec and frozen acceptance (recorded on Python 2.7)");
    await writeFile(join(l.baseline, "base.ref"), (await git(l, "rev-parse", "HEAD")).trim() + "\n");
    void basename;
    return manifest;
  }

  async passesOnLegacy(_spec: UnitSpec, _scenario: ProposedScenario): Promise<boolean> {
    // Proposed scenarios are prose; turning them into recorded checks is a human step here.
    return false;
  }

  async addScenario(): Promise<BaselineManifest> {
    throw new Error("baseline updates are not automated; proposed scenarios are logged for a person");
  }
}

// ─── git facts and checkpoint ────────────────────────────────────────────────

export async function baseRef(l: Layout): Promise<string> {
  return (await readFile(join(l.baseline, "base.ref"), "utf8")).trim();
}

/** Commits whatever the factory left in the workspace and returns the commit. */
export async function commitWorkspace(l: Layout, message: string): Promise<string> {
  await git(l, "add", "-A");
  const staged = await exec("git", ["-C", l.workspace, "diff", "--cached", "--quiet"]);
  if (staged.code !== 0) await git(l, "commit", "-qm", message);
  return (await git(l, "rev-parse", "HEAD")).trim();
}

/** Extracts a commit into a fresh directory (clean checkout: no stray files, no agent state). */
export async function checkout(l: Layout, ref: string, dir: string): Promise<string> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const archive = await exec("bash", ["-c", `git -C "$1" archive "$2" | tar -x -C "$3"`, "_", l.workspace, ref, dir]);
  if (archive.code !== 0) throw new Error(`cannot check out ${ref}: ${archive.stderr}`);
  return dir;
}

export class GitRepo implements RepoService {
  private readonly l: Layout;
  constructor(l: Layout) {
    this.l = l;
  }

  async changedFiles(_spec: UnitSpec, patchRef: string): Promise<string[]> {
    const out = await git(this.l, "diff", "--name-only", "--no-renames", await baseRef(this.l), patchRef);
    return out.split("\n").filter(Boolean).sort();
  }

  async checkpoint(spec: UnitSpec, bundle: EvidenceBundle, summary: string): Promise<string> {
    const tag = `migrated/${spec.unitId}`;
    await git(this.l, "tag", "-f", "-a", tag, bundle.patchRef, "-m", summary);
    await writeFile(join(this.l.run, "RESULT"), `${tag} ${bundle.patchRef}\n`);
    return `${tag}@${bundle.patchRef.slice(0, 10)}`;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
