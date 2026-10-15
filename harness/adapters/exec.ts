/**
 * The only place the harness starts processes. Every call has a timeout and
 * honours the lifecycle's AbortSignal, so a stuck agent becomes a stall that
 * Pi escalates instead of a run that hangs forever.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Also tee stdout/stderr into this file (raw agent transcripts for the audit trail). */
  logFile?: string;
  /**
   * Raise the child's out-of-memory priority (0–1000). Agents get a high value,
   * so when memory runs out the kernel kills an agent, never the harness itself.
   */
  oomScoreAdj?: number;
  /** After the child exits, kill whatever it left behind in its process group (test servers, browsers). */
  reapGroup?: boolean;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the child was killed by a signal (e.g. SIGKILL from the out-of-memory killer). */
  signal: string | null;
}

export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const [file, argv] = opts.oomScoreAdj
      ? ["/bin/sh", ["-c", `echo ${opts.oomScoreAdj} > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"`, cmd, ...args]]
      : [cmd, args];
    const child = spawn(file, argv, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group, so a timeout kills the whole agent tree
    });
    const log = opts.logFile ? createWriteStream(opts.logFile, { flags: "a" }) : null;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGTERM");
        setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
        }, 5000).unref();
      } catch { /* already exited */ }
    };
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs) : null;
    const onAbort = () => { aborted = true; kill(); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); log?.write(d); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); log?.write(d); });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      log?.end();
      reject(new Error(`cannot start ${cmd}: ${e.message}`));
    });
    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      log?.end();
      if (opts.reapGroup) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* nothing left */ }
      }
      resolve({ code, stdout, stderr, timedOut, aborted, signal: sig ?? null });
    });
    // A child that exits or closes stdin early must not crash the harness (EPIPE).
    child.stdin.on("error", () => {});
    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** exec that throws on a non-zero exit; for git and other plumbing. */
export async function must(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-600)}`);
  }
  return r.stdout;
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export const lastLine = (text: string) => text.trim().split("\n").filter(Boolean).pop() ?? "";
