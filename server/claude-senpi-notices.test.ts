import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { forgetTranscriptState, parseClaudeTranscript, transcriptPage } from "./conversation.ts";
import { turnStarts } from "./transcript-turns.ts";

// Recorded from OmO (senpi, anthropic-subscription) driving Claude Code 2.1.292 through its SDK; only the home
// directory is renamed. senpi sends its own notices in the person's seat, in the SDK prompt: a Kibitzer memory note
// along with two host tool results, three `task completion` reports and a `<system-reminder>` loop guard.
const RUN = fileURLToPath(new URL("./fixtures/claude-senpi-notices-2.1.292.jsonl", import.meta.url));
const recorded = readFileSync(RUN, "utf8");
// One SDK prompt per line, each recorded on its own (Claude Code 2.1.286 to 2.1.292, home directory renamed):
// a fresh session's history replay ending in the person's question, a goal continuation, a team member's
// message along with a host result, and a lead's message along with a host result.
const [replay, goal, peer, lead] = readFileSync(fileURLToPath(new URL("./fixtures/claude-senpi-notice-prompts.jsonl", import.meta.url)), "utf8").split("\n").filter(Boolean);

type TaskResult = Extract<ConversationPart, { kind: "task_result" }>;
const said = (turns: ConversationTurn[]): string[] =>
  turns.filter((turn) => turn.role === "user").flatMap((turn) => turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : []));
const cards = (turns: ConversationTurn[]): TaskResult["tasks"] =>
  turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "task_result" ? part.tasks : []));
const SENPI_WORDS = ["<recalled-memory", "<system-reminder>", "task completion name:", "<conversation_history>", "Continue working toward the active thread goal.", "<peer_message", "<environment_context>"];

describe("senpi's own notices in a Claude Code SDK prompt", () => {
  it("never puts them in the person's seat", () => {
    const turns = parseClaudeTranscript(recorded);
    expect(said(turns)).toEqual([]);
    const shown = JSON.stringify(turns);
    for (const words of SENPI_WORDS) expect(shown).not.toContain(words);
  });

  it("shows each task completion as the card of the task that ended, where it arrived", () => {
    const turns = parseClaudeTranscript(recorded);
    // each report wakes the agent after an answer: its card, then the work it started
    expect(turns.map((turn) => turn.parts[0]?.kind === "task_result" ? "card" : turn.role)).toEqual(["assistant", "card", "assistant", "card", "assistant", "assistant", "card", "assistant", "assistant"]);
    expect(cards(turns).map(({ id, title, agent, model, status, duration_ms, tokens, tool_calls }) => ({ id, title, agent, model, status, duration_ms, tokens, tool_calls }))).toEqual([
      { id: "st_01a1175a", title: "rv534", agent: "deep-low", model: "Claude Opus 5.5", status: "completed", duration_ms: 200_000, tokens: 612311, tool_calls: 7 },
      { id: "st_01a1175b", title: "rv539", agent: "deep-low", model: "Claude Opus 5.5", status: "completed", duration_ms: 238_000, tokens: 1217374, tool_calls: 53 },
      { id: "st_01a1175c", title: "rv513", agent: "deep-low", model: "Claude Opus 5.5", status: "completed", duration_ms: 263_000, tokens: 1017829, tool_calls: 62 },
    ]);
    expect(cards(turns)[0]!.result).toBe("That cell is still running on the host; once it comes back I'll pick up from the unit-test, typecheck, rebase-probe and gate results.");
    expect(cards(turns)[1]!.result).toStartWith("The review draft is written at `/tmp/rev-plan-reviews/pr539.md`");
    expect(cards(turns)[1]!.result).toEndWith("The three named unit test files pass (51 tests) and the typecheck is clean.");
  });

  it("still reads the host results sent along with a notice as their calls' output", () => {
    const tools = parseClaudeTranscript(recorded).flatMap((turn) => turn.parts.flatMap((part) => part.kind === "tool" ? [part] : []));
    expect(tools.map((tool) => [tool.call_id, tool.state, tool.output])).toEqual([
      ["toolu_01WkTSdcrq8pi6M8VSmTBANs", "ok", "Revived st_01a11759 (run epoch 1)."],
      ["toolu_01UdaTFUxEyC3Np4sMZ7aWcb", "ok", "Task capacity is full; retry explicitly."],
      ["toolu_013DnaDBRZq3ThHnscu2F8RS", "ok", "Revived st_01a11758 (run epoch 1)."],
      ["toolu_018FHxxNcL5ZtKccFZDTURZN", "ok", "Task capacity is full; retry explicitly."],
    ]);
  });

  it("keeps only the person's question of a fresh session's history replay", () => {
    expect(said(parseClaudeTranscript(replay!))).toEqual(["현재 머지된 PR 들 간단히 요약해줄래?"]);
  });

  it("keeps a goal continuation out of the person's seat", () => {
    expect(parseClaudeTranscript(goal!)).toEqual([]);
  });

  it("shows a team member's message as theirs, not the person's", () => {
    const turns = parseClaudeTranscript(peer!);
    expect(said(turns)).toEqual([]);
    expect(turns.flatMap((turn) => turn.parts.filter((part) => part.kind === "notice"))).toEqual([{
      kind: "notice", source: "peer:android-emulator",
      text: "WORKING: A3 android-emulator - briefing read, starting first search wave (KVM on hosted runners, android-emulator-runner, Chrome on system images, Playwright _android, WebAPK minting, FTL / emulator.wtf / Genymotion pricing).",
    }]);
  });

  it("keeps a lead's message sent along with a host result as the message it is", () => {
    expect(said(parseClaudeTranscript(lead!))).toEqual(["[LEAD] your work thread has had no update for 17 min. Post a 1-2 sentence progress line (done since last, next) and keep its status true."]);
  });

  it("keeps a person's own message that only looks like a notice", () => {
    const user = (content: unknown, extra: Record<string, unknown>) => JSON.stringify({ type: "user", ...extra, message: { role: "user", content } });
    const reminder = "<system-reminder>quoted</system-reminder>";
    expect(said(parseClaudeTranscript([
      // typed at Claude Code's own prompt
      user([{ type: "text", text: reminder }], { promptSource: "typed", entrypoint: "cli" }),
      // a program's prompt with words of its own after the wrapper
      user([{ type: "text", text: `${reminder}\nwhy is this here?` }], { promptSource: "sdk", entrypoint: "sdk-ts" }),
      // a tag senpi does not send
      user([{ type: "text", text: "<details>mine</details>" }], { promptSource: "sdk", entrypoint: "sdk-ts" }),
    ].join("\n")))).toEqual([reminder, `${reminder}\nwhy is this here?`, "<details>mine</details>"]);
  });

  describe("read in pages, as the chat reads a file", () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); forgetTranscriptState(); });

    it("opens a page only at what a person sent", () => {
      expect(turnStarts(Buffer.from(recorded), "claude-transcript")).toEqual([]);
      expect([replay, goal, peer, lead].map((line) => turnStarts(Buffer.from(line!), "claude-transcript"))).toEqual([[0], [], [], []]);
    });

    it("reads the same turns as the whole file", () => {
      const root = mkdtempSync(join(tmpdir(), "ovis-senpi-notices-")); roots.push(root);
      const path = join(root, "session.jsonl");
      writeFileSync(path, recorded);
      const { turns } = transcriptPage("claude-transcript", path);
      expect(said(turns)).toEqual([]);
      expect(cards(turns)).toEqual(cards(parseClaudeTranscript(recorded)));
    });
  });
});
