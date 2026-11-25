import { expect, it } from "bun:test";
import { questionFields } from "./question-form.ts";

// Minimal fields from the native v1 probes. The labels and wire values are not interchangeable.
const color = "Red or blue?";
const choice = (value: string) => ({ const: value, title: "Blue" });
const select = (value: string) => ({ type: "string", oneOf: [choice(value)] });
const form = (properties: object) => ({ mode: "form", toolCallId: "tool-1", message: color, requestedSchema: { type: "object", properties } });

it.each([
  ["claude", form({ question_0: select("Blue"), question_0_custom: { type: "string" } }), "Blue"],
  ["agy", form({ q1: { ...select("2"), title: color }, q1_other: { type: "string" } }), "2"],
  ["gjc", { ...form({ value: select("option:0") }), toolCallId: undefined }, "option:0"],
  ["codex", { ...form({ color: { ...select("Blue"), title: color, _meta: { codex: { isSecret: false, isOther: false } } } }), _meta: { codex: { autoResolutionMs: null } } }, "Blue"],
] as const)("keeps the %s question's wire value behind its display label", (harness, request, value) => {
  expect(questionFields(harness, request)).toMatchObject([{ prompt: color, choices: [{ label: "Blue", value }] }]);
});

it("does not delegate Claude's confirmation or fallback consent, or Codex secret input", () => {
  expect(questionFields("claude", { ...form({ question_0: select("Download") }), toolCallId: "confirm_1" })).toBeNull();
  expect(questionFields("claude", form({ choice: select("retry_fallback") }))).toBeNull();
  expect(questionFields("codex", { ...form({ secret: { type: "string", _meta: { codex: { isSecret: true, isOther: false } } } }), _meta: { codex: { autoResolutionMs: null } } })).toBeNull();
});

it("recognizes GJC's free-text follow-up after the parent chooses Other", () => {
  const request = { mode: "form", message: "What color?", requestedSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  expect(questionFields("gjc", request)).toMatchObject([{ prompt: "What color?", choices: [], custom: "value" }]);
});
