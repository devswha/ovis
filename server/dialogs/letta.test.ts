import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import { KEY } from "./shared.ts";

// Screens of letta-code 0.34.31's /model, recorded with colour in a herdr pane 120 columns wide
// (local backend, Claude subscription providers for Anthropic and Amazon Bedrock).
const screen = (name: string) => readFileSync(new URL(`../fixtures/letta/${name}-0.34.31.txt`, import.meta.url), "utf8");
const card = (shown: string) => {
  const prompt = parseInteractivePrompt("letta", shown);
  return prompt && { question: prompt.question, options: prompt.options.map((option) => option.label) };
};

describe("Letta Code's /model", () => {
  it("offers the models the picker draws, the tabs beside the one shown, and a search", () => {
    // Recents is shown: → is Recommended, ← wraps to All models
    expect(card(screen("model-recents"))).toEqual({
      question: "Select model for this session",
      options: ["Claude Opus 5.5 · Anthropic", "Claude Sonnet 5.5 · Anthropic", "openai-codex/gpt-6.1-sol", "Claude Opus 5.5 · Amazon Bedrock", "Claude Sonnet 5.5 · Amazon Bedrock",
        "Show the Recommended [12] tab", "Show the All models [21] tab", "Search models", "Cancel"],
    });
    expect(card(screen("model-recommended"))).toMatchObject({
      question: "Select model for this session. 5 more models in this tab: search, or show another tab.",
      options: ["Claude Opus 5.5 · Anthropic", "Claude Sonnet 5.5 · Anthropic", "Claude Haiku 4.5 · Anthropic", "Claude Fable 5.1 · Anthropic",
        "Claude Opus 4.8 · Anthropic", "Claude Sonnet 4.6 · Anthropic", "Claude Opus 5.5 · Amazon Bedrock", "Show the All models [21] tab", "Show the Recents [5] tab", "Search models", "Cancel"],
    });
  });

  it("switches a tab with one key, and searches a key at a time", () => {
    const prompt = parseInteractivePrompt("letta", screen("model-recents"))!;
    expect(answerKeys(prompt, { option_index: 5 })).toEqual([{ keys: [KEY.right] }]);
    expect(answerKeys(prompt, { option_index: 6 })).toEqual([{ keys: [KEY.left] }]);
    expect(prompt.custom_option_index).toBe(7);
    expect(answerKeys(prompt, { custom_text: "son" })).toEqual([{ text: "s" }, { text: "o" }, { text: "n" }]);
    // with the search empty, `r` would refresh the list: its capital goes in, and Letta matches without case
    expect(answerKeys(prompt, { custom_text: "ri" })).toEqual([{ text: "R" }, { text: "i" }]);
    // Cancel is Esc, which closes the picker
    expect(answerKeys(prompt, { option_index: 8 })).toEqual([{ keys: [KEY.escape] }]);
  });

  it("picks a row with the arrows from the cursor, then Enter", () => {
    const shown = screen("model-recents-cursor");
    const prompt = parseInteractivePrompt("letta", shown)!;
    // the cursor is on the third row
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: [KEY.up] }, { keys: [KEY.up] }, { keys: [KEY.enter] }]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: [KEY.enter] }]);
    expect(answerKeys(prompt, { option_index: 4 })).toEqual([{ keys: [KEY.down] }, { keys: [KEY.down] }, { keys: [KEY.enter] }]);
  });

  it("offers the reasoning level the next step shows, and leaves the others to the terminal", () => {
    const prompt = parseInteractivePrompt("letta", screen("effort"))!;
    expect(prompt.question).toBe("Select reasoning level for openai-codex/gpt-6.1-sol for this session (currently Medium). More levels are listed in the terminal.");
    expect(prompt.options.map((option) => option.label)).toEqual(["Medium", "Cancel"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: [KEY.enter] }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: [KEY.escape] }]);
  });

  it("refuses a search Letta would not type: control characters, and characters it drops", () => {
    const prompt = parseInteractivePrompt("letta", screen("model-recents"))!;
    // Letta's search takes one UTF-16 unit per key: an emoji never reaches it, and a cut one is a lone surrogate
    for (const text of ["son\rnet", "so\u001bhi", "a\u0000b", "a\u009fb", `${"a".repeat(39)}🙂`]) {
      expect(() => answerKeys(prompt, { custom_text: text }), JSON.stringify(text)).toThrow();
    }
  });

  it("reads no picker once output follows it, nor another agent's screen", () => {
    expect(parseInteractivePrompt("letta", `${screen("model-recents")}\n• Model switched\n`)).toBeNull();
    expect(parseInteractivePrompt("letta", `${screen("effort")}\n› \n`)).toBeNull();
    expect(parseInteractivePrompt("claude", screen("model-recents"))?.question ?? null).not.toBe("Select model for this session");
  });
});
