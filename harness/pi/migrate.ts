/**
 * Pi front end for the migration harness.
 *
 *   pi --extension /opt/harnesses-plural/harness/pi/migrate.ts
 *
 *   /migrate RUN_DIR        start (or resume) the unit in the background, 24/7
 *   /migrate-status         where the unit is: node, trace, runs, repairs, cost
 *   /migrate-decide         answer an escalation (the only human step)
 *
 * The lifecycle itself runs as its own process (harness/run.ts), so closing
 * Pi never stops a migration; Pi watches its status file and the decisions folder.
 */
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HARNESS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let runDir: string | null = process.env.HARNESS_RUN_DIR ?? null;
let timer: ReturnType<typeof setInterval> | null = null;

function status(dir: string) {
  const f = join(dir, "status.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

function openCase(dir: string): { n: number; data: any } | null {
  const d = join(dir, "decisions");
  if (!existsSync(d)) return null;
  const cases = readdirSync(d).map((f) => Number((f.match(/^case-(\d+)\.json$/) ?? [])[1] ?? 0)).filter(Boolean).sort((a, b) => b - a);
  for (const n of cases) {
    if (!existsSync(join(d, `answer-${n}.json`))) return { n, data: JSON.parse(readFileSync(join(d, `case-${n}.json`), "utf8")) };
  }
  return null;
}

function line(s: any): string {
  if (!s) return "no status yet";
  return `${s.node} · ${s.status} · run ${s.factoryRuns} · repairs ${s.repairs} · $${s.costUsd} · ${s.elapsedMin} min`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("migrate", {
    description: "Start or resume the migration harness: /migrate RUN_DIR",
    handler: async (args, ctx) => {
      const dir = resolve((args || runDir || "").trim());
      if (!dir || dir === resolve("")) {
        ctx.ui.notify("usage: /migrate /srv/runs/suggested-plan-1", "warning");
        return;
      }
      runDir = dir;
      const log = openSync(join(dir, "..", `${dir.split("/").pop()}.log`), "a");
      const child = spawn("node", [join(HARNESS, "run.ts"), dir], { detached: true, stdio: ["ignore", log, log] });
      child.unref();
      ctx.ui.notify(`Harness started for ${dir} (pid ${child.pid}). It keeps running if you close Pi.`, "info");
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        if (!runDir) return;
        const c = openCase(runDir);
        ctx.ui.setStatus("migrate", c ? `⏸ needs you: ${c.data.reason} (/migrate-decide)` : `migrate: ${line(status(runDir))}`);
      }, 10_000);
    },
  });

  pi.registerCommand("migrate-status", {
    description: "Show where the migration unit is",
    handler: async (args, ctx) => {
      const dir = resolve((args || runDir || "").trim());
      const s = status(dir);
      ctx.ui.notify(s ? `${line(s)}\n${s.trace.join(" → ")}` : `no status in ${dir}`, "info");
    },
  });

  pi.registerCommand("migrate-decide", {
    description: "Answer the open escalation of the migration unit",
    handler: async (args, ctx) => {
      const dir = resolve((args || runDir || "").trim());
      const c = openCase(dir);
      if (!c) {
        ctx.ui.notify("Nothing waits for a decision.", "info");
        return;
      }
      ctx.ui.notify(`${c.data.reason}: ${c.data.summary}\nfindings: ${(c.data.findings ?? []).map((f: any) => `${f.id} ${f.summary}`).join("; ") || "none"}`, "warning");
      const kind = await ctx.ui.select(`Decision for case ${c.n}`, c.data.allowed);
      if (!kind) return;
      const note = (await ctx.ui.input("Note for the audit trail", "why")) ?? "";
      let decision: unknown;
      if (kind === "approve_difference") {
        const deviationId = (await ctx.ui.input("Deviation register ID", "DEV-001")) ?? "DEV-001";
        decision = { kind, deviationId, dismissFindingIds: (c.data.findings ?? []).map((f: any) => f.id), note };
      } else if (kind === "require_repair") {
        decision = { kind, items: [{ source: "human", ref: `human-${c.n}`, summary: note, files: [] }], note };
      } else {
        decision = { kind, note };
      }
      writeFileSync(join(dir, "decisions", `answer-${c.n}.json`), JSON.stringify(decision, null, 2));
      ctx.ui.notify(`Recorded "${kind}". The harness continues within a few seconds.`, "info");
    },
  });

  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
}
