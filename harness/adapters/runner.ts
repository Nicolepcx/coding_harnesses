/**
 * Wires the real adapters into the Pi lifecycle and runs one unit.
 * Used by run.ts (CLI), the Pi extension and the end-to-end test.
 */
import { existsSync } from "node:fs";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { policy as defaultPolicy } from "../config/policy.ts";
import { MigrationLifecycle } from "../src/lifecycle.ts";
import type { Policy } from "../src/policy.ts";
import type { Ports } from "../src/ports.ts";
import type { UnitState } from "../src/state.ts";
import { FileStore } from "../src/store.ts";
import { FrozenAcceptance } from "./acceptance.ts";
import { HeadlessClaudeFactory } from "./claude.ts";
import { CodexExecVerifier } from "./codex.ts";
import { exec } from "./exec.ts";
import { FileHumanGate } from "./humans.ts";
import { ensureDirs, type Layout } from "./layout.ts";
import { FrozenBaseline, GitRepo, WorkspaceScope, prepareWorkspace } from "./workspace.ts";

export function realPorts(l: Layout, notify: (t: string) => void): Ports {
  return {
    scope: new WorkspaceScope(l),
    baseline: new FrozenBaseline(l),
    factory: new HeadlessClaudeFactory(l),
    codex: new CodexExecVerifier(l),
    acceptance: new FrozenAcceptance(l),
    repo: new GitRepo(l),
    humans: new FileHumanGate(l, notify),
  };
}

/** Fails fast, before any agent spends anything, if a tool is missing. */
export async function preflight(l: Layout, needAgents: boolean): Promise<string[]> {
  const problems: string[] = [];
  const check = async (cmd: string, args: string[], label: string) => {
    try {
      const r = await exec(cmd, args, { timeoutMs: 30_000 });
      if (r.code !== 0) problems.push(`${label}: exit ${r.code} ${r.stderr.trim().slice(-200)}`);
    } catch (e) {
      problems.push(`${label}: ${(e as Error).message}`);
    }
  };
  await check(l.py2, ["-c", "import sys; assert sys.version_info[:2] == (2, 7)"], "python 2.7");
  await check(l.py3, ["-c", "import sys; assert sys.version_info[0] == 3"], "python 3");
  await check("git", ["--version"], "git");
  if (!existsSync(join(l.pwNodeModules, "@playwright", "test"))) problems.push(`Playwright not installed at ${l.pwNodeModules}`);
  if (!existsSync(join(l.app, l.domain.dataFile))) problems.push(`legacy app or data file not found in ${l.app}`);
  if (needAgents) {
    await check("claude", ["--version"], "claude");
    await check("codex", ["--version"], "codex");
  }
  return problems;
}

export interface RunOptions {
  ports?: Ports;
  policy?: Policy;
  notify?: (text: string) => void;
}

export async function runUnit(l: Layout, opts: RunOptions = {}): Promise<UnitState> {
  const notify = opts.notify ?? ((t: string) => console.log(t));
  await ensureDirs(l);
  const lock = join(l.run, ".lock");
  if (existsSync(lock)) {
    const pid = Number(await readFile(lock, "utf8"));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
    if (alive && pid !== process.pid) throw new Error(`another harness process (pid ${pid}) is running this unit`);
  }
  await writeFile(lock, String(process.pid));
  try {
    await prepareWorkspace(l);
    const ports = opts.ports ?? realPorts(l, notify);
    const store = new FileStore(l.state);
    const started = Date.now();
    const lifecycle = new MigrationLifecycle(ports, opts.policy ?? defaultPolicy, store, {
      onTransition: (s, step) => {
        const t = new Date().toISOString().slice(11, 19);
        const line = `[${t}] ${step.from.padEnd(6)} → ${s.trace[s.trace.length - 1].padEnd(16)} ${step.note.length > 240 ? step.note.slice(0, 240) + " …" : step.note}`;
        notify(line);
        void appendFile(join(l.run, "progress.log"), line + "\n");
        void writeFile(join(l.run, "status.json"), JSON.stringify({
          node: s.node, status: s.status, trace: s.trace, costUsd: Number(s.costUsd.toFixed(2)),
          factoryRuns: s.factory.runs, repairs: s.repair.count, patchRef: s.bundle?.patchRef ?? null,
          escalation: s.escalation, elapsedMin: Math.round((Date.now() - started) / 60_000), updatedAt: s.updatedAt,
        }, null, 2));
      },
    });
    return await lifecycle.run(l.domain.unitId);
  } finally {
    await rm(lock, { force: true });
  }
}
