import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inputRowState, screenFromAnsi } from "../../shared/input-row.ts";
import { grokQueue, showsMessage } from "./grok-queue.ts";
import { grokScreen, type GrokScreenState } from "./grok-screen.fake.ts";

// Grok 1.0.77's screens as herdr's detection read gave them (src/lib/fixtures-input-rows/README.md)
const recorded = (name: string): string => readFileSync(join(import.meta.dir, "../../src/lib/fixtures-input-rows/grok-1.0.77", `${name}-119.txt`), "utf8");
const promptState = (screen: string) => inputRowState("grok", screenFromAnsi(screen));

describe("Grok's queue and prompt on recorded screens", () => {
  it.each([
    ["idle", { mode: "fullscreen", rows: [], enterSendsNow: false }, "ready"],
    ["working", { mode: "fullscreen", rows: [], enterSendsNow: false }, "ready"],
    ["queued-1-hint", { mode: "fullscreen", rows: ["first follow-up please"], enterSendsNow: true }, "ready"],
    ["queued-1", { mode: "fullscreen", rows: ["fourth follow-up please"], enterSendsNow: true }, "ready"],
    ["queued-3", { mode: "fullscreen", rows: ["first follow-up please", "second follow-up please", "third follow-up please"], enterSendsNow: true }, "ready"],
    ["after-send-now", { mode: "fullscreen", rows: ["second follow-up please", "third follow-up please"], enterSendsNow: true }, "ready"],
    ["queued-multiline", { mode: "fullscreen", rows: [
      "a long queued follow-up part1 part2 part3 part4 part5 part6 part7 part8 part9 part10 part11 part12 part13 par…", "multi line A (+1 line)"], enterSendsNow: true }, "ready"],
    // the focus off the prompt: its placeholder reads as a draft, and the framed queue pane as no queue to read
    ["queue-pane-focused", null, "draft"],
    ["scrollback-focused", { mode: "fullscreen", rows: [], enterSendsNow: false }, "draft"],
    // the approval card replaces the input box
    ["permission", null, "gone"],
    ["draft-lines", { mode: "fullscreen", rows: [], enterSendsNow: false }, "draft"],
    ["draft-second-line", { mode: "fullscreen", rows: [], enterSendsNow: false }, "draft"],
    ["minimal-working", { mode: "minimal", count: 0 }, "gone"],
    ["minimal-queued-1", { mode: "minimal", count: 1 }, "gone"],
    ["minimal-queued-2", { mode: "minimal", count: 2 }, "gone"],
  ] as const)("%s", (name, queue, prompt) => {
    const screen = recorded(name);
    expect(grokQueue(screen)).toEqual(queue);
    expect(promptState(screen)).toBe(prompt);
  });

  it("knows each queued row Grok drew for the message it was typed from", () => {
    const long = `a long queued follow-up ${Array.from({ length: 30 }, (_, index) => `part${index + 1}`).join(" ")}`;
    expect(showsMessage("first follow-up please", "first follow-up please")).toBe(true);
    expect(showsMessage("multi line A (+1 line)", "multi line A\nmulti line B")).toBe(true);
    expect(showsMessage("a long queued follow-up part1 part2 part3 part4 part5 part6 part7 part8 part9 part10 part11 part12 part13 par…", long)).toBe(true);
    expect(showsMessage("first follow-up please", "first follow-up")).toBe(false);
    expect(showsMessage("multi line A", "multi line A\nmulti line B")).toBe(false);
    expect(showsMessage("multi line A (+1 line)", "multi line A")).toBe(false);
  });
});

it("draws the stand-in Grok's screens as the recorded ones read", () => {
  const states: Record<string, GrokScreenState> = {
    idle: { status: "done", output: ["Turn cancelled by user in 1.7s."], prompt: "", queue: [] },
    working: { status: "working", output: ["word1 word2"], prompt: "", queue: [] },
    "queued-3": { status: "working", output: ["word1 word2"], prompt: "", queue: ["first follow-up please", "second follow-up please", "third follow-up please"] },
    "draft-second-line": { status: "working", output: ["word1 word2"], prompt: "\nsecond row only", queue: [] },
    permission: { status: "blocked", output: ["◆ Running scratch command"], prompt: "", queue: [], card: true },
    "minimal-queued-2": { status: "working", output: ["word1 word2"], prompt: "", queue: ["minimal follow-up one", "minimal follow-up two"], minimal: true },
  };
  for (const [name, state] of Object.entries(states)) {
    const read = (screen: string) => ({ queue: grokQueue(screen), prompt: promptState(screen) });
    expect([name, read(grokScreen(state))]).toEqual([name, read(recorded(name))]);
  }
});
