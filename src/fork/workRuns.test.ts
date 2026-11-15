import { describe, expect, it } from "bun:test";
import type { ConversationPart } from "../../shared/protocol.ts";
import { runCounts, workItems } from "./workRuns.tsx";

const tool = (name: string): Extract<ConversationPart, { kind: "tool" }> => ({ kind: "tool", name, summary: name, input: "{}", output: "" });

describe("work runs", () => {
  it("folds each stretch between narration into one run, counted by outcome in first-seen order", () => {
    const parts: ConversationPart[] = [
      { kind: "thinking", text: "a" }, tool("bash"), tool("read"), tool("bash"),
      { kind: "text", text: "Pushing now:" },
      { ...tool("bash"), error: true }, { ...tool("bash"), running: true }, { ...tool("mcp"), input: "{\"tool\":\"slack_send\"}" },
    ];
    const items = workItems(parts, parts);
    expect(items.map((item) => item.kind === "run" ? `run@${item.start}×${item.parts.length}` : item.part.kind)).toEqual(["run@0×4", "text", "run@5×3"]);
    const last = items[2]!;
    if (last.kind !== "run") throw new Error("not a run");
    expect(runCounts(last.parts, true)).toEqual({ done: [{ name: "slack_send", count: 1 }], failed: [{ name: "bash", count: 1 }], running: [{ name: "bash", count: 1 }] });
    // Settled, a call left without a result was cut off: done, not running.
    expect(runCounts(last.parts, false).running).toEqual([]);
    const first = items[0]!;
    if (first.kind === "run") expect(runCounts(first.parts, false).done).toEqual([{ name: "think", count: 1 }, { name: "bash", count: 2 }, { name: "read", count: 1 }]);
  });
});
