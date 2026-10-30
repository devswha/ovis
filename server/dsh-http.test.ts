import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { forgetPaneTranscriptState, forgetTranscriptState } from "./conversation.ts";
import * as herdr from "./herdr/client.ts";
import { handlePaneRequest } from "./pane-routes.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
linuxTest("serves a bound dsh conversation over HTTP and invalidates its ETag after an append", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovis-dsh-http-"));
  const session = "12345678-1234-1234-1234-123456789abc";
  const folder = join(root, "sessions", session);
  await mkdir(folder, { recursive: true });
  const path = join(folder, "session.v4.jsonl");
  const rows = [
    { type: "session", version: 4, id: session, delegationDepth: 0 },
    { type: "user/message", seq: 0, data: { source: { kind: "user" }, content: [{ type: "text", text: "Hello" }] } },
  ];
  const save = () => writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await save();
  const lock = await open(join(folder, "session.lock"), "w");
  const pane = { pane_id: "dsh-http-fixture", agent: "dsh", agent_status: "idle", cwd: root };
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane], agents: [] } as unknown as SessionSnapshot);
  const processInfo = spyOn(herdr, "paneProcessInfo").mockResolvedValue({ foreground_processes: [{ pid: process.pid, argv: ["/bin/dsh"] }] } as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  const url = new URL("http://x/api/pane/conversation?pane_id=" + pane.pane_id);
  const ask = async (etag?: string) => (await handlePaneRequest(new Request(url, { headers: etag ? { "if-none-match": etag } : {} }), url, url.pathname, {}))!;
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    const initial = await ask();
    expect(initial.status).toBe(200);
    const body = await initial.json();
    expect(body.source).toBe("dsh-transcript");
    expect(body.turns[0].parts[0]).toEqual({ kind: "text", text: "Hello" });
    const etag = initial.headers.get("etag")!;
    expect((await ask(etag)).status).toBe(304);
    rows.push({ type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "Again" }] } });
    await save();
    const appended = await ask(etag);
    expect(appended.status).toBe(200);
    expect((await appended.json()).turns).toHaveLength(2);
    expect(appended.headers.get("etag")).not.toBe(etag);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    snapshot.mockRestore();
    processInfo.mockRestore();
    forgetPaneTranscriptState(pane.pane_id);
    forgetTranscriptState();
    await lock.close();
    await rm(root, { recursive: true, force: true });
  }
});
