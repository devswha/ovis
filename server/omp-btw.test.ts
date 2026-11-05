import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleBtwRequest, ompBtwTopics } from "./omp-btw.ts";

// the records OMP 18.14 saves for a /btw topic (packages/coding-agent/src/session/btw-history.ts; synthetic content)
const exchange = (question: string, answer: string, createdAt: number, status = "complete") => ({ question, answer, status, createdAt, updatedAt: createdAt + 1000 });
const topic = (id: string, createdAt: number, extra: Record<string, unknown> = {}) => ({ ...exchange(`question ${id}`, `answer ${id}`, createdAt), id, leafId: "637ac31c", ...extra });

describe("ompBtwTopics", () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "ovis-btw-")); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** a session file and its artifacts folder (the file's path without `.jsonl`), as OMP lays them out */
  const session = (name: string): { transcript: string; history: string } => {
    const transcript = join(root, `${name}.jsonl`);
    writeFileSync(transcript, "");
    const history = join(root, name, "btw-history");
    mkdirSync(history, { recursive: true });
    return { transcript, history };
  };
  const save = (history: string, record: Record<string, unknown>, name = `entry-${String(record["id"])}.json`) => writeFileSync(join(history, name), JSON.stringify(record));

  it("lists the main session's saved topics newest first, with their titles and follow-ups, and no pictures", () => {
    const { transcript, history } = session("listed");
    save(history, topic("aaa", 1_792_642_086_836, { images: [{ type: "image", data: "AAAA", mimeType: "image/png" }], followUps: [exchange("and then?", "then this", 1_792_642_095_925), exchange("still going?", "", 1_792_642_099_000, "running")] }));
    save(history, topic("bbb", 1_792_642_171_669, { status: "error", error: "model refused" }));
    writeFileSync(join(history, "entry-aaa.title"), "Named topic");

    expect(ompBtwTopics(transcript)).toEqual([
      { id: "bbb", title: null, question: "question bbb", answer: "answer bbb", status: "error", error: "model refused", at: new Date(1_792_642_171_669).toISOString(), follow_ups: [] },
      {
        id: "aaa", title: "Named topic", question: "question aaa", answer: "answer aaa", status: "complete", error: null, at: new Date(1_792_642_086_836).toISOString(),
        follow_ups: [
          { question: "and then?", answer: "then this", status: "complete", error: null, at: new Date(1_792_642_095_925).toISOString() },
          { question: "still going?", answer: "", status: "running", error: null, at: new Date(1_792_642_099_000).toISOString() },
        ],
      },
    ]);
  });

  it("reads only well-formed topic files of the main session: not a subagent's history, a lock, a link or a record OMP would refuse", () => {
    const { transcript, history } = session("guarded");
    save(history, topic("kept", 1));
    // a focused subagent's own history (btw-history/sessions/<key>) is another conversation
    mkdirSync(join(history, "sessions", "sub"), { recursive: true });
    save(join(history, "sessions", "sub"), topic("subagent", 2));
    save(history, topic("other", 3), "entry-renamed.json");
    save(history, { ...topic("bad", 4), status: "thinking" });
    save(history, { ...topic("extra", 5), surprise: true });
    writeFileSync(join(history, "entry-broken.json"), "{");
    writeFileSync(join(history, "entry-locked.json.lock"), "");
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify(topic("linked", 6)));
    symlinkSync(outside, join(history, "entry-linked.json"));

    expect(ompBtwTopics(transcript).map((found) => found.id)).toEqual(["kept"]);
  });

  it("answers none for a session that never used /btw", () => {
    const transcript = join(root, "quiet.jsonl");
    writeFileSync(transcript, "");
    expect(ompBtwTopics(transcript)).toEqual([]);
  });
});

describe("GET /api/pane/btw", () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "ovis-btw-route-")); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const ask = (path: string, transcript: (paneId: string) => Promise<string | null>, method = "GET") => {
    const url = new URL(`http://localhost${path}`);
    return handleBtwRequest(new Request(url, { method }), url, url.pathname, { transcript });
  };

  it("answers the topics of the pane's own OMP session, none for a pane without one, and refuses a bad request", async () => {
    const transcript = join(root, "pane.jsonl");
    writeFileSync(transcript, "");
    mkdirSync(join(root, "pane", "btw-history"), { recursive: true });
    writeFileSync(join(root, "pane", "btw-history", "entry-t1.json"), JSON.stringify(topic("t1", 10)));
    const panes = async (paneId: string) => paneId === "w1:p1" ? transcript : null;

    const found = await ask("/api/pane/btw?pane_id=w1:p1", panes);
    expect(found?.status).toBe(200);
    expect(((await found?.json()) as { topics: { id: string }[] }).topics.map((entry) => entry.id)).toEqual(["t1"]);
    expect(await (await ask("/api/pane/btw?pane_id=w1:p2", panes))?.json()).toEqual({ topics: [] });
    expect((await ask("/api/pane/btw", panes))?.status).toBe(400);
    expect((await ask("/api/pane/btw?pane_id=w1:p1", panes, "POST"))?.status).toBe(400);
    expect(await ask("/api/pane/plan?pane_id=w1:p1", panes)).toBeNull();
  });
});
