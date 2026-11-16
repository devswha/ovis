import { describe, expect, it } from "bun:test";
import { modelMark } from "./modelMark.ts";

describe("modelMark", () => {
  it("a model's maker comes from its name, whatever provider carries it", () => {
    expect(modelMark("claude-bridge/claude-opus-5-5")).toBe("claude");
    expect(modelMark("openrouter/anthropic/claude-sonnet-5-5")).toBe("claude");
    expect(modelMark("openai-codex/gpt-6.1-sol")).toBe("codex");
    expect(modelMark("google/gemini-3-pro")).toBe("gemini");
    expect(modelMark("local/llama-4")).toBeNull();
  });
});
