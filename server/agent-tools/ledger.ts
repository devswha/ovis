import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/harness-tool.ts";
import { writePrivate } from "./runs.ts";
import type { AuditRecord } from "../../shared/harness-contract.generated.ts";

export interface ToolChild {
  id: string;
  terminal: string;
  harness: string;
  parent: string;
  starter: string;
  run: string;
  created: number;
  held: boolean;
  turns: { key: string | null; n: number; seq: number | null; end: string | null }[];
}
function isChild(row: unknown): row is ToolChild {
  return isRecord(row) && ["id","terminal","harness","parent","starter","run"].every(k => typeof row[k] === "string")
    && typeof row.created === "number" && typeof row.held === "boolean"
    && Array.isArray(row.turns) && row.turns.every(t => isRecord(t) && Number.isSafeInteger(t.n) && (t.seq === null || Number.isSafeInteger(t.seq)) && (t.key === null || typeof t.key === "string") && (t.end === null || typeof t.end === "string"));
}
export class Ledger {
  readonly children = new Map<string, ToolChild>();
  constructor(private readonly dir: string) {
    const path = join(dir, "children.json");
    if (!existsSync(path)) return;
    const rows: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(rows) || !rows.every(isChild)) throw new Error("Cannot read agent tool children.");
    for (const row of rows) this.children.set(row.terminal, row);
  }
  save(): void { writePrivate(join(this.dir, "children.json"), JSON.stringify([...this.children.values()])); }
  audit(row: ToolChild, verb: "start" | "stop" | "send" | "turn", turn: number | null, end: string | null = null): void {
    const file = join(this.dir, "audit.jsonl");
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) >= 10 * 1024 * 1024) renameSync(file, join(this.dir, "audit.1.jsonl"));
    const record: AuditRecord = { at: new Date().toISOString(), run: row.starter, parent: row.parent, child: row.terminal, machine: "local", harness: row.harness, verb, turn_id: turn === null ? null : `${row.id}.${turn}`, stop_reason: end };
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
}
