/**
 * A Codex question card answered as data: where the Codex server Ovis started in the pane (approvals/codex.ts) waits on
 * the very question the card shows, a pick of one of its options goes back by the request's id, with no key. Codex
 * takes an option's label as its answer, as its TUI sends it (`{"answers":{"<id>":{"answers":["Red"]}}}`, 0.171.0).
 *
 * A card of a question answered lately, by Ovis or from the terminal, takes no key either, even where the connection
 * to the server was lost since: its TUI may not have drawn the next screen yet. Whatever the card cannot say whole
 * stays the TUI's, as keys: several questions in one request (Codex's tabs), secret input, "None of the above" and its
 * notes, and any question the server does not wait on.
 */
import type { PromptAnswer } from "../shared/protocol.ts";
import { answerServedQuestion, servedAnswered, servedQuestions } from "./approvals/codex.ts";
import type { CodexAsk } from "./approvals/codex-status.ts";
import type { ParsedPrompt } from "./dialogs/shared.ts";

/** Whether `ask` is the one question `card` shows whole: not secret, the same words, the same options in the same order. */
function shows(card: ParsedPrompt, ask: CodexAsk): boolean {
  const [question, ...more] = ask.questions;
  return question !== undefined && more.length === 0 && !question.isSecret && question.question === card.question && question.options !== null
    && JSON.stringify(question.options.map((option) => option.label)) === JSON.stringify(card.options.map((option) => option.label));
}

/** What Codex takes for `body` on `ask`'s question: one of its options picked, and nothing else; null for any other answer. */
export function servedAnswers(ask: CodexAsk, body: PromptAnswer): Record<string, { answers: string[] }> | null {
  const [question] = ask.questions;
  const option = Number.isInteger(body.option_index) ? question?.options?.[body.option_index!] : undefined;
  if (question === undefined || option === undefined || body.option_indices !== undefined || body.custom_text !== undefined
    || body.step_back !== undefined || body.step_next !== undefined || body.step_index !== undefined || body.draft !== undefined) return null;
  return { [question.id]: { answers: [option.label] } };
}

/**
 * Answers `body` on `card` as data where the pane's Codex server waits on its question: "sent" once the answer went,
 * "gone" where the card is a question answered lately and none waits that it shows (no key may answer it), and null
 * where the answer is the TUI's to take as keys.
 */
export function answerServed(paneId: string, card: ParsedPrompt, body: PromptAnswer): "sent" | "gone" | null {
  if (card.responder !== "codex-question" || card.nativeSteps !== undefined) return null;
  const waiting = servedQuestions(paneId).filter((ask) => shows(card, ask));
  if (waiting.length === 0) return servedAnswered(paneId).some((ask) => shows(card, ask)) ? "gone" : null;
  // two questions alike: the card cannot say which it is, and the TUI answers the one it draws
  if (waiting.length > 1) return null;
  const answers = servedAnswers(waiting[0]!, body);
  if (answers === null) return null;
  return answerServedQuestion(paneId, waiting[0]!.key, answers) ? "sent" : "gone";
}
