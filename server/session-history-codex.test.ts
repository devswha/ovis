import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions } from "./session-history.ts";

it("lists saved Codex names and first messages when available (#4799)", () => {
  const home = mkdtempSync(join(tmpdir(), "ovis-codex-resume-"));
  try {
    const codexHome = join(home, "codex-profile");
    const cwd = join(home, "project");
    const day = join(codexHome, "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    mkdirSync(cwd);
    const startedAt = "2026-10-20T09:00:00.000Z";
    const sqlite = "00000000-0000-4000-8000-000000000001";
    const index = "00000000-0000-4000-8000-000000000002";
    const prompt = "00000000-0000-4000-8000-000000000003";
    const unlabeled = "00000000-0000-4000-8000-000000000004";
    for (const [id, message] of [[sqlite, null], [index, "First draft"], [prompt, "Explain the failing check"], [unlabeled, null]]) {
      const records = [{ type: "session_meta", payload: { id, cwd, source: "cli", timestamp: startedAt } }];
      const path = join(day, `rollout-2026-10-20T09-00-00-${id}.jsonl`);
      const event = { type: "event_msg", payload: { type: "user_message", message } };
      writeFileSync(path, [...records, ...(message === null ? [] : [event])].map((record) => JSON.stringify(record)).join("\n") + "\n");
      utimesSync(path, new Date(startedAt), new Date(startedAt));
    }
    {
      using db = new Database(join(codexHome, "state_5.sqlite"));
      db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, first_user_message TEXT NOT NULL)");
      db.query("INSERT INTO threads VALUES (?, ?, ?)").run(sqlite, "Review release notes", "Prompt beyond the rollout head");
      db.query("INSERT INTO threads VALUES (?, ?, ?)").run(index, "Old database label", "");
      db.query("INSERT INTO threads VALUES (?, ?, ?)").run(prompt, " ", "");
    }
    writeFileSync(join(codexHome, "session_index.jsonl"), [
      { id: index, thread_name: "Original name", updated_at: "2026-10-20T09:01:00Z" },
      { id: index, thread_name: "Compare rollout formats", updated_at: "2026-10-20T09:02:00Z" },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");

    const rows = listSessions("codex", cwd, { home, codexHome, env: {} });

    expect(Object.fromEntries(rows.map((row) => [row.id, [row.title, row.firstMessage, row.startedAt]]))).toEqual({
      [sqlite]: ["Review release notes", "Prompt beyond the rollout head", startedAt],
      [index]: ["Compare rollout formats", "First draft", startedAt],
      [prompt]: [null, "Explain the failing check", startedAt],
      [unlabeled]: [null, null, startedAt],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
