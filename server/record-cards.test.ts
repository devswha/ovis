import { describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyRecord } from "./dialogs/agy-record.ts";
import { copilotRecord } from "./dialogs/copilot-record.ts";
import { hermesRecord, type HermesMessage } from "./dialogs/hermes-record.ts";
import { gjcRecord } from "./dialogs/gjc-record.ts";
import { grokRecord } from "./dialogs/grok-record.ts";
import { lettaRecord } from "./dialogs/letta-record.ts";
import { museRecord } from "./dialogs/muse-record.ts";
import type { AgentRecord, RecordRequest } from "./dialogs/record.ts";
import * as conversation from "./conversation.ts";
import { recordRequest, recordSettled } from "./record-cards.ts";

test("a Copilot question follows its foreground binding and file generation, not just its call id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-copilot-ask-"));
  const path = join(dir, "events.jsonl");
  const start = JSON.stringify({ type: "tool.execution_start", data: { toolCallId: "pick", toolName: "ask_user",
    arguments: { message: "Pick", requestedSchema: { properties: { color: { type: "string", enum: ["red", "blue"] } } } } } }) + "\n";
  let binding = "first-pid";
  const lookup = spyOn(conversation, "paneTranscript").mockImplementation(async () => ({ source: "copilot-transcript", path, binding, peerClaims: new Set<string>() }));
  try {
    writeFileSync(path, start);
    const read = () => recordRequest("pane", "copilot-question");
    const first = (await read())!;
    expect(first.unchanged?.()).toBe(true);
    binding = "second-pid";
    const next = (await read())!;
    expect(next.id).not.toBe(first.id);
    writeFileSync(join(dir, "replacement"), start);
    renameSync(join(dir, "replacement"), path);
    expect(next.unchanged?.()).toBe(false);
    const replaced = (await read())!;
    expect(replaced.id).not.toBe(next.id);
    appendFileSync(path, JSON.stringify({ type: "human_response.recorded", data: { toolCallId: "pick" } }) + "\n");
    expect(replaced.unchanged?.()).toBe(false);
    expect(await read()).toBeNull();
  } finally { lookup.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

interface Turn { turn: string; decision: "allow" | "deny"; record: unknown; after: unknown }

/** A record read `reads` in turn, its last one again once they run out. */
const reading = (reads: (RecordRequest | null | undefined)[]) => {
  let at = 0;
  return async () => reads[Math.min(at++, reads.length - 1)];
};

describe("what a record says of a request after its card's key went", () => {
  const request = { id: "s\0call-1", command: "ls" };

  test("closed once the record holds no request or another, open while it still holds that one, unread with no record", async () => {
    expect(await recordSettled("p", "copilot", request.id, 1_000, reading([request, request, null]))).toBe("closed");
    expect(await recordSettled("p", "copilot", request.id, 1_000, reading([request, { id: "s\0call-2", command: "ls" }]))).toBe("closed");
    expect(await recordSettled("p", "copilot", request.id, 1_000, reading([undefined]))).toBe("unread");
    expect(await recordSettled("p", "copilot", request.id, 0, reading([request]))).toBe("open");
  });

  // the seven records, as recorded (server/fixtures/record-cards): every allowed request closes; a refused one closes
  // too, but Letta leaves it open, so "open" is no proof that a key did not take
  const lines = (record: AgentRecord) => (rows: unknown) => record.pending((rows as string[]).join("\n"));
  const AGENTS: [string, (rows: unknown) => RecordRequest | null][] = [
    ["gjc", lines(gjcRecord)], ["grok", lines(grokRecord)], ["copilot", lines(copilotRecord)], ["letta", lines(lettaRecord)], ["muse", lines(museRecord)],
    ["agy", (rows) => agyRecord.pending((rows as { idx: number; payload: string }[]).map(({ idx, payload }) => ({ idx, payload: Buffer.from(payload, "base64") })))],
    ["hermes", (rows) => hermesRecord.pending(rows as HermesMessage[])],
  ];
  for (const [agent, pending] of AGENTS) {
    const { turns } = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/record-cards", `${agent}.json`), "utf8")) as { turns: Turn[] };
    test.each(turns.map((turn) => [agent, turn.turn, turn] as const))("%s %s", async (_agent, _name, turn) => {
      const before = pending(turn.record)!;
      const outcome = await recordSettled("p", agent, before.id, 0, reading([pending(turn.after)]));
      expect(outcome).toBe(agent === "letta" && turn.decision === "deny" ? "open" : "closed");
    });
  }
});
