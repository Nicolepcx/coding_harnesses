/**
 * Durable unit store: state.json (atomic), audit.jsonl (append-only) and
 * artifacts/ (every bundle, acceptance result, report and decision).
 * This directory is the migration's audit trail.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UnitState } from "./state.ts";

export interface AuditEvent {
  ts: string;
  unitId: string;
  from: string;
  to: string;
  note: string;
  refs?: string[];
}

export interface UnitStore {
  load(unitId: string): Promise<UnitState | null>;
  save(state: UnitState): Promise<void>;
  audit(event: AuditEvent): Promise<void>;
  /** Persists a JSON artifact and returns its reference (a path). */
  artifact(unitId: string, name: string, data: unknown): Promise<string>;
}

export class FileStore implements UnitStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  private dir(unitId: string) {
    return join(this.root, unitId);
  }

  async load(unitId: string): Promise<UnitState | null> {
    try {
      return JSON.parse(await readFile(join(this.dir(unitId), "state.json"), "utf8")) as UnitState;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async save(state: UnitState): Promise<void> {
    const dir = this.dir(state.unitId);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `state.json.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, join(dir, "state.json"));
  }

  async audit(event: AuditEvent): Promise<void> {
    const dir = this.dir(event.unitId);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "audit.jsonl"), JSON.stringify(event) + "\n");
  }

  async artifact(unitId: string, name: string, data: unknown): Promise<string> {
    const dir = join(this.dir(unitId), "artifacts");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${name}.json`);
    await writeFile(file, JSON.stringify(data, null, 2));
    return file;
  }
}

/** In-memory store for the simulator and tests. */
export class MemoryStore implements UnitStore {
  states = new Map<string, string>();
  events: AuditEvent[] = [];
  artifacts = new Map<string, unknown>();

  async load(unitId: string) {
    const s = this.states.get(unitId);
    return s ? (JSON.parse(s) as UnitState) : null;
  }
  async save(state: UnitState) {
    this.states.set(state.unitId, JSON.stringify(state));
  }
  async audit(event: AuditEvent) {
    this.events.push(event);
  }
  async artifact(unitId: string, name: string, data: unknown) {
    const ref = `mem://${unitId}/${name}`;
    this.artifacts.set(ref, data);
    return ref;
  }
}
