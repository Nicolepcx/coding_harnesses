/**
 * The TypeBox contracts are already JSON Schema. Agents' structured-output
 * modes want a slightly stricter dialect: every enum typed, every object closed
 * and fully required. This produces that view without changing the contracts.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TSchema } from "typebox";

export function strictSchema(schema: TSchema): unknown {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k.startsWith("~")) continue; // TypeBox-internal markers
      out[k] = walk(v);
    }
    if (Array.isArray(out.enum) && !out.type) out.type = "string";
    if (out.type === "object" && out.properties) {
      out.required = Object.keys(out.properties as object);
      out.additionalProperties = false;
    }
    return out;
  };
  return walk(JSON.parse(JSON.stringify(schema)));
}

export async function writeSchema(path: string, schema: TSchema): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(strictSchema(schema), null, 1));
  return path;
}
