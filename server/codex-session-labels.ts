import type { Database } from "bun:sqlite";
import { readSync } from "node:fs";

const INDEX_BYTES = 1024 * 1024;

/** Codex appends name changes; the last entry, including a cleared name, wins. */
export function codexIndexedNames(fd: number, size: number): ReadonlyMap<string, string> {
  const offset = Math.max(0, size - INDEX_BYTES);
  const buffer = Buffer.alloc(size - offset);
  const length = readSync(fd, buffer, 0, buffer.length, offset);
  const names = new Map<string, string>();
  const lines = buffer.toString("utf8", 0, length).split("\n");
  // A bounded tail can start in the middle of a record.
  for (const line of offset === 0 ? lines : lines.slice(1)) {
    let entry: unknown;
    try { entry = JSON.parse(line); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (entry && typeof entry === "object" && "id" in entry && "thread_name" in entry
      && typeof entry.id === "string" && typeof entry.thread_name === "string") {
      names.set(entry.id, entry.thread_name);
    }
  }
  return names;
}

type Label = { readonly id: string; readonly title: string | null; readonly firstMessage: string | null };

/** Only read metadata for the bounded set of interactive rollouts already selected. */
export function codexStoredLabels(db: Database, ids: readonly string[], limits: { readonly title: number; readonly message: number }): ReadonlyMap<string, Label> {
  if (ids.length === 0) return new Map();
  const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('threads')").all().map(({ name }) => name));
  if (!columns.has("id")) return new Map();
  const title = columns.has("title") ? `NULLIF(trim(substr(title, 1, ${limits.title})), '')` : "NULL";
  const name = columns.has("name") ? `NULLIF(trim(substr(name, 1, ${limits.title})), '')` : "NULL";
  const first = columns.has("first_user_message") ? `substr(first_user_message, 1, ${limits.message})` : "NULL";
  const labels = db.query<Label, string[]>(
    `SELECT id, coalesce(${name}, ${title}) AS title, ${first} AS firstMessage FROM threads WHERE id IN (${ids.map(() => "?").join(", ")})`,
  ).all(...ids);
  return new Map(labels.map((label) => [label.id, label]));
}
