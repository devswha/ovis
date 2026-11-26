/**
 * A Claude question card answered as data: where the PermissionRequest hook of a Claude Ovis started holds the one
 * question the card shows (approvals/claude.ts), the card is bound to that request (prompt.ts withHeldPermission), and
 * its answer goes back as that request's input with no key: an option's label, several joined with ", ", or the words
 * typed, as Claude Code 2.1.330 takes them. Whatever the card cannot say whole stays the dialog's, as keys: a request of
 * several questions (a tab each), and any answer but one of those three.
 */
import type { InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
import type { HeldQuestion } from "./approvals/hub.ts";

/** Whether `card` shows `question` whole: its options in the same order, and one pick or several as it takes. */
export function showsHeldQuestion(card: InteractivePrompt, question: HeldQuestion): boolean {
  return card.multi_select === question.multiSelect
    && JSON.stringify(card.options.map((option) => option.label)) === JSON.stringify(question.options);
}

/** What Claude takes for `body` on `card`'s question, or null for an answer that goes as keys. */
export function heldQuestionAnswer(card: InteractivePrompt, body: PromptAnswer): string | null {
  if (body.step_back !== undefined || body.step_next !== undefined || body.step_index !== undefined || body.draft !== undefined) return null;
  const given = [body.option_index, body.option_indices, body.custom_text].filter((answer) => answer !== undefined);
  if (given.length !== 1) return null;
  if (body.option_index !== undefined) {
    return card.multi_select || !Number.isInteger(body.option_index) ? null : card.options[body.option_index]?.label ?? null;
  }
  if (body.option_indices !== undefined) {
    const picked = Array.isArray(body.option_indices) ? body.option_indices : [];
    const valid = picked.length > 0 && new Set(picked).size === picked.length
      && picked.every((index) => Number.isInteger(index) && index >= 0 && index < card.options.length);
    return card.multi_select && valid ? [...picked].sort((a, b) => a - b).map((index) => card.options[index]!.label).join(", ") : null;
  }
  return !card.multi_select && typeof body.custom_text === "string" && body.custom_text.trim() !== "" ? body.custom_text : null;
}
