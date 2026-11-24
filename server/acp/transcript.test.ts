import { expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryChanged } from "../conversation-shared.ts";
import { KeeperClient } from "./client.ts";

// Live prompt plus the user echo gjc sends, Codex-style edits, and a session/load replay.
it("pages prompts once, folds tool updates and replaces the visible history only on a complete replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "archive-"));
  const socket = new Socket();
  const client = new KeeperClient(root, { connect: () => socket });
  let seq = 0;
  const row = (dir: string, message: unknown) => {
    const line = JSON.stringify({ dir, seq: ++seq, ts: 1000 + seq, raw: JSON.stringify(message) }) + "\n";
    appendFileSync(join(root, "archive.jsonl"), line); socket.emit("data", line);
  };
  const update = (value: unknown) => row("from-agent", { method: "session/update", params: { sessionId: "child", update: value } });
  const chunk = (sessionUpdate: string, text: string) => update({ sessionUpdate, content: { type: "text", text } });
  const prompt = (text: string) => row("to-agent", { id: "p" + seq, method: "session/prompt", params: { sessionId: "child", prompt: [{ type: "text", text }] } });
  const mode = (phase: string) => row("keeper", { method: "_keeper/mode", params: { mode: "acp", phase } });
  try {
    prompt("First"); chunk("user_message_chunk", "First"); chunk("agent_message_chunk", "One");
    prompt("Edit"); chunk("agent_thought_chunk", "Check the note");
    update({ sessionUpdate: "tool_call", toolCallId: "t1", kind: "edit", title: "Change note" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "diff", path: "note.txt", oldText: "A", newText: "B" }] });
    row("from-agent", { method: "session/request_permission", id: "agent-1", params: { toolCall: { title: "Only on the card" } } });
    chunk("agent_message_chunk", "Done"); update({ sessionUpdate: "plan", entries: [{ content: "Check note", status: "completed", priority: "medium" }] });
    const last = await client.history.page({ prompts: 1 });
    expect(last.turns).toMatchObject([{ role: "user", parts: [{ text: "Edit" }] }, { role: "assistant", parts: [{ kind: "thinking", text: "Check the note" }, { kind: "tool", summary: "Change note", state: "ok", input: JSON.stringify({ file_path: "note.txt", old_string: "A", new_string: "B" }), output: "--- note.txt\nA\n+++ note.txt\nB" }, { text: "Done" }, { kind: "tool", name: "plan" }] }]);
    expect(client.history.plan).toMatchObject([{ label: "Check note", status: "completed" }]);
    if (!last.cursor) throw new Error("no older page");
    expect((await client.history.page({ before: last.cursor })).turns.map(t => t.parts)).toEqual([[{ kind: "text", text: "First" }], [{ kind: "text", text: "One" }]]);
    mode("start"); chunk("user_message_chunk", "Discarded replay"); mode("failed");
    expect((await client.history.page({ prompts: 1 })).turns).toEqual(last.turns);
    mode("start"); chunk("user_message_chunk", "From the TUI"); chunk("agent_message_chunk", "Reply");
    expect((await client.history.page({})).history_id).toBe(last.history_id);
    mode("ready");
    expect((await client.history.page({})).turns.map(t => t.parts)).toEqual([[{ kind: "text", text: "From the TUI" }], [{ kind: "text", text: "Reply" }]]);
    expect(client.history.plan).toBeNull();
    await expect(client.history.page({ before: last.cursor })).rejects.toBeInstanceOf(HistoryChanged);
  } finally { client.close(); rmSync(root, { recursive: true, force: true }); }
});
