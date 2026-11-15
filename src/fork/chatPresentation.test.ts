import { expect, it } from "bun:test";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { withoutEmptyLiveTurn } from "./chatPresentation.ts";

it("retains settled turns, including empty ones, and never hides a user send", () => {
  const turns: ConversationTurn[] = [{ role: "assistant", ts: null, parts: [] }];
  expect(withoutEmptyLiveTurn(turns, false, false)).toBe(turns);
  const sent: ConversationTurn[] = [{ role: "user", ts: null, parts: [] }];
  expect(withoutEmptyLiveTurn(sent, true, false)).toBe(sent);
});

it("holds the live placeholder until there is visible work or an answer", () => {
  const blank: ConversationTurn[] = [{ role: "assistant", ts: null, parts: [] }];
  expect(withoutEmptyLiveTurn(blank, true, false)).toEqual([]);
  const thinking: ConversationTurn[] = [{ role: "assistant", ts: null, parts: [{ kind: "thinking", text: "working" }] }];
  expect(withoutEmptyLiveTurn(thinking, true, false)).toEqual([]);
  expect(withoutEmptyLiveTurn(thinking, true, true)).toBe(thinking);
  const answer: ConversationTurn[] = [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "answer" }] }];
  expect(withoutEmptyLiveTurn(answer, true, false)).toBe(answer);
});
