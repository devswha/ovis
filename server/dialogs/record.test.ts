import { describe, expect, test } from "bun:test";
import { pendingToolCall, withRecord, type AgentRecord } from "./record.ts";
import { parsedByPublicPrompt } from "./shared.ts";
import { parseFallbackPrompt } from "./fallback.ts";

const DIALOG = /^Run this command\?$/;

const screen = (...rows: string[]): string => ["previous output", "", ...rows].join("\n");

describe("withRecord", () => {
  const record: AgentRecord = { pending: () => null, dialog: DIALOG };
  const cardOf = (screen: string) => parsedByPublicPrompt.get(parseFallbackPrompt("letta", screen))!;
  const menu = ["", "❯ 1. Yes", "  2. No", "Enter to select · Esc to cancel"];
  const drawn = screen("Run this command?", "echo hello", ...menu);
  const card = cardOf(drawn);
  const bound = (screenText: string, command: string) => withRecord(cardOf(screenText), { id: "c", command }, screenText, record);

  test("puts the record's command in place of the rows that draw it and binds the card to its request", () => {
    const shown = withRecord(card, { id: "call-1", command: "echo hello" }, drawn, record);
    expect(shown.body).toBe(card.body);
    expect(shown.record).toEqual({ id: "call-1", command: "echo hello" });
    expect(shown.id).not.toBe(card.id);
    expect(shown.optionSteps).toEqual(card.optionSteps);
    expect(withRecord(card, { id: "call-2", command: "echo hello" }, drawn, record).id).not.toBe(shown.id);
  });

  test("a command the dialog wraps and boxes is shown whole, the rest of the dialog kept", () => {
    const boxed = screen("╭──────────────╮", "│ Run this command? │", "│ $ echo 'a b' && │", "│ printf 한글 │", "╰──────────────╯", "Stage 1/2", ...menu);
    const shown = withRecord(cardOf(boxed), { id: "c", command: "echo 'a b' &&\n\tprintf 한글" }, boxed, record);
    expect(shown.record?.command).toBe("echo 'a b' &&\n\tprintf 한글");
    expect(shown.body).toContain("echo 'a b' &&\n\tprintf 한글\nStage 1/2");
  });

  test("keeps the screen's card for a dialog that draws another command, or cuts it", () => {
    for (const [rows, command] of [
      [["ls -l ab"], "ls -l a b"],
      [["git status --short"], "git status"],
      [["git status", "--short"], "git status"],
      [["Show the folder:", "  then run pwd"], "pwd"],
      [["echo first sec…"], "echo first second"],
      [["echo bye"], "echo hello"],
    ] as const) {
      const text = screen("Run this command?", ...rows, ...menu);
      expect(bound(text, command).record).toBeUndefined();
    }
    expect(withRecord(card, null, drawn, record)).toBe(card);
    expect(bound(screen("echo hello", ...menu), "echo hello").record).toBeUndefined();
  });

  test("only the last dialog counts, not an older one above it", () => {
    const twice = screen("Run this command?", "rm -rf ./old", "Run this command?", "ls", ...menu);
    expect(bound(twice, "rm -rf ./old").record).toBeUndefined();
    expect(bound(twice, "ls").record?.command).toBe("ls");
  });

  test("an agent with no dialog line of its own is read from the card's words, its own rows around the command", () => {
    expect(withRecord(card, { id: "c", command: "echo hello" }, "", { before: /^previous output$/u }).record?.command).toBe("echo hello");
    expect(withRecord(card, { id: "c", command: "echo hello" }, "", {}).record).toBeUndefined();
  });
});

describe("pendingToolCall", () => {
  const line = (message: unknown): string => JSON.stringify({ type: "message", message });
  const call = (id: string, command: string, name = "bash"): string =>
    line({ role: "assistant", content: [{ type: "text", text: "running" }, { type: "toolCall", id, name, arguments: { command } }] });
  const result = (id: string): string => line({ role: "toolResult", toolCallId: id, content: [] });
  const BASH = new Set(["bash"]);

  test("the last call with no result is open", () => {
    expect(pendingToolCall([call("a", "ls"), result("a"), call("b", "cat <<'EOF'\n\tx\nEOF")].join("\n"), BASH))
      .toEqual({ id: "b", command: "cat <<'EOF'\n\tx\nEOF" });
  });

  test("a call with its result, another tool's call, or a half-written line leaves none open", () => {
    expect(pendingToolCall([call("a", "ls"), result("a")].join("\n"), BASH)).toBeNull();
    expect(pendingToolCall(call("a", "ls", "read"), BASH)).toBeNull();
    expect(pendingToolCall(`${result("x")}\n{"type":"message","message":{"role":"assis`, BASH)).toBeNull();
  });

  test("two calls open at once name no request", () => {
    expect(pendingToolCall([call("a", "make"), call("b", "rm -rf build && make")].join("\n"), BASH)).toBeNull();
    expect(pendingToolCall([call("a", "cat x", "read"), call("b", "ls")].join("\n"), BASH)).toBeNull();
  });

  test("a call the user's next turn left behind (refused, interrupted) is no longer open", () => {
    const refused = [call("a", "rm -rf build"), line({ role: "user", content: [{ type: "text", text: "no" }] })];
    expect(pendingToolCall(refused.join("\n"), BASH)).toBeNull();
    expect(pendingToolCall([...refused, call("b", "ls")].join("\n"), BASH)).toEqual({ id: "b", command: "ls" });
  });
});
