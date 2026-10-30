import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import { KEY } from "./shared.ts";

// Screens of letta-code 0.34.31's /model, recorded with colour in a herdr pane 120 columns wide
// (local backend, Claude subscription providers named Mimosa and ING).
const screen = (name: string) => readFileSync(new URL(`../fixtures/letta/${name}-0.34.31.txt`, import.meta.url), "utf8");
const card = (shown: string) => {
  const prompt = parseInteractivePrompt("letta", shown);
  return prompt && { question: prompt.question, options: prompt.options.map((option) => option.label) };
};

describe("Letta Code's /model", () => {
  it("offers the models the picker draws, and tells how many more the tab holds", () => {
    expect(card(screen("model-recents"))).toEqual({
      question: "Select model for this session",
      options: ["Claude Opus 5.5 · Mimosa", "Claude Sonnet 5.5 · Mimosa", "openai-codex/gpt-6.1-sol", "Claude Opus 5.5 · ING", "Claude Sonnet 5.5 · ING"],
    });
    expect(card(screen("model-recommended"))).toMatchObject({
      question: "Select model for this session. 5 more models are listed in the terminal.",
      options: ["Claude Opus 5.5 · Mimosa", "Claude Sonnet 5.5 · Mimosa", "Claude Haiku 4.5 · Mimosa", "Claude Fable 5.1 · Mimosa",
        "Claude Opus 4.8 · Mimosa", "Claude Sonnet 4.6 · Mimosa", "Claude Opus 5.5 · ING"],
    });
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
    expect(prompt.options.map((option) => option.label)).toEqual(["Medium"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: [KEY.enter] }]);
  });

  it("reads no picker once output follows it, nor another agent's screen", () => {
    expect(parseInteractivePrompt("letta", `${screen("model-recents")}\n• Model switched\n`)).toBeNull();
    expect(parseInteractivePrompt("letta", `${screen("effort")}\n› \n`)).toBeNull();
    expect(parseInteractivePrompt("claude", screen("model-recents"))?.question ?? null).not.toBe("Select model for this session");
  });
});
