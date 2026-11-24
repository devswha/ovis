import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ompRecap } from "./omp-recap.ts";

// omp 19.1.1's session index (packages/coding-agent/src/session/session-index.ts); synthetic content
const SCHEMA = `CREATE TABLE session_recaps (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, cwd TEXT NOT NULL,
  recap TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)))`;
const SECONDS = 1_795_527_563;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;

describe("ompRecap", () => {
  let root: string;
  let data: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ovis-recap-"));
    data = join(root, "agent");
    mkdirSync(join(data, "sessions", "-work-"), { recursive: true });
    const db = new Database(join(data, "history.db"));
    db.run("PRAGMA journal_mode=WAL");
    db.run(SCHEMA);
    const insert = db.prepare("INSERT INTO session_recaps (session_id, cwd, recap, created_at) VALUES (?, ?, ?, ?)");
    insert.run("s-away", "/work", "older recap", SECONDS - 600);
    insert.run("s-away", "/work", "  Goal: ship it. Next: review.  ", SECONDS);
    insert.run("s-back", "/work", "stale recap", SECONDS);
    insert.run("s-same", "/work", "same-second recap", SECONDS);
    insert.run("other", "/work", "another session's recap", SECONDS + 60);
    db.close();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const session = (id: string, lastMessageAt: string, dir = join(data, "sessions", "-work-")) => {
    const path = join(dir, `2026-11-24T13-21-03-414Z_${id}.jsonl`);
    writeFileSync(path, line({ type: "title", title: "t" }) + line({ type: "session", version: 3, id, cwd: "/work" })
      + line({ type: "message", timestamp: lastMessageAt, message: { role: "assistant", content: [{ type: "text", text: "done" }] } })
      + line({ type: "model_usage", timestamp: iso(SECONDS), purpose: "recap" }));
    return path;
  };

  it("answers the session's newest recap, trimmed, while the model's answer is the last message", () => {
    expect(ompRecap(session("s-away", iso(SECONDS - 240)))).toEqual({ text: "Goal: ship it. Next: review.", at: iso(SECONDS) });
  });

  it("answers none once a message is newer than the recap, even in the second it was saved", () => {
    expect(ompRecap(session("s-back", iso(SECONDS + 30)))).toBeNull();
    expect(ompRecap(session("s-same", new Date(SECONDS * 1000 + 400).toISOString()))).toBeNull();
  });

  it("answers none for a session without a recap, one outside a store, or a store whose history.db is a link", () => {
    expect(ompRecap(session("never", iso(SECONDS - 240)))).toBeNull();
    const own = join(root, "own-session-dir");
    mkdirSync(own);
    expect(ompRecap(session("s-away", iso(SECONDS - 240), own))).toBeNull();
    const linked = join(root, "linked");
    mkdirSync(join(linked, "sessions", "-work-"), { recursive: true });
    symlinkSync(join(data, "history.db"), join(linked, "history.db"));
    expect(ompRecap(session("s-away", iso(SECONDS - 240), join(linked, "sessions", "-work-")))).toBeNull();
  });
});
