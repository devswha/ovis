/**
 * The first line of each agent pane's first message, shared with the other browsers of the server
 * (the `tab_labels` of shared/preferences.ts, through lib/preferencesSync.ts). A tab still named
 * only by herdr's number or by its agent shows a short label from it, and the whole line on hover
 * (lib/tabName.ts autoTabLabel), so tabs of the same agent tell apart (#2019). It is an Ovis display
 * name only: herdr's tab label is never written, so herdr's own tab row and its other clients keep
 * theirs. A pane is keyed with its PC (`paneStorageId`), as the mutes are.
 *
 * A pane's line is learned once, from what Ovis knows first: the New tab dialog's first message, a
 * Chat send with no earlier message known, or a transcript read from its beginning. It is never
 * replaced: a later message, or another browser's line for the same pane, leaves it.
 */

import { paneStorageId } from "../../shared/machines.ts";
import { MAX_TAB_LABEL_LENGTH, mergeTabLabels } from "../../shared/preferences.ts";
import type { ConversationResponse, ConversationTurn } from "../../shared/protocol.ts";

/** how many columns a tab shows of the line before it is cut with an ellipsis; a wide character (Hangul, CJK, an emoji) takes two */
export const SHORT_TAB_LABEL_COLUMNS = 24;
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u;

let labels: Readonly<Record<string, string>> = {};
const listeners = new Set<() => void>();

export const tabLabelKey = paneStorageId;

/** The labels as this page knows them: the server's, and the ones learned here and not yet sent. */
export function currentTabLabels(): Readonly<Record<string, string>> {
  return labels;
}

export function setTabLabels(next: Readonly<Record<string, string>>): void {
  const before = Object.entries(labels);
  const after = Object.entries(next);
  if (before.length === after.length && after.every(([key, line], index) => before[index]?.[0] === key && before[index]?.[1] === line)) return;
  labels = { ...next };
  for (const listener of [...listeners]) listener();
}

export function subscribeTabLabels(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The line a message gives a tab: its first line that says something, its spaces collapsed, cut to
 * what the server keeps; null for a message with no words (only spaces, a picture).
 */
export function firstPromptLine(text: string): string | null {
  const line = text.split(/\r\n|[\n\r\u2028\u2029]/).map((part) => part.replace(/\s+/g, " ").trim()).find((part) => part !== "");
  if (line === undefined) return null;
  return line.length <= MAX_TAB_LABEL_LENGTH ? line : `${cutAt(line, MAX_TAB_LABEL_LENGTH - 1).trimEnd()}…`;
}

/** A line's characters as drawn: graphemes, or code points where the browser has no Intl.Segmenter (Safari 14). */
function characters(text: string): string[] {
  return typeof Intl.Segmenter === "function" ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(({ segment }) => segment) : Array.from(text);
}

/** At most `max` characters of `text`, never splitting a character drawn as one (an emoji, a Hangul syllable with its marks). */
function cutAt(text: string, max: number): string {
  let out = "";
  for (const segment of characters(text)) {
    if (out.length + segment.length > max) break;
    out += segment;
  }
  return out;
}

/**
 * What the tab shows of a line: a few words, cut at a word's end when one is near the limit, else at
 * the limit (a language written without spaces), with an ellipsis when anything was cut.
 */
export function shortTabLabel(line: string): string {
  const head: string[] = [];
  let columns = 0;
  let space = -1;
  let spaceAt = 0;
  for (const segment of characters(line)) {
    const width = WIDE.test(segment) ? 2 : 1;
    if (columns + width > SHORT_TAB_LABEL_COLUMNS) {
      const kept = space >= 0 && spaceAt >= SHORT_TAB_LABEL_COLUMNS / 2 ? head.slice(0, space) : head;
      return `${kept.join("").trimEnd()}…`;
    }
    if (segment === " ") { space = head.length; spaceAt = columns; }
    head.push(segment);
    columns += width;
  }
  return line;
}

/** Learns a pane's line from `text` unless it has one: true when it was learned. */
export function learnTabLabel(machineId: string, paneId: string, text: string): boolean {
  const key = tabLabelKey(machineId, paneId);
  if (key in labels) return false;
  const line = firstPromptLine(text);
  if (line === null) return false;
  setTabLabels(mergeTabLabels(labels, { [key]: line }) ?? {});
  return true;
}

/** panes whose chat is drawn from the screen (no transcript Ovis reads): a message sent from Chat is the first Ovis can know of */
const untranscribed = new Set<string>();

/**
 * What a conversation answer teaches (ChatView): the first message of turns read from the beginning
 * (`cursor` null), and whether the pane has a transcript at all.
 */
export function learnFromConversation(machineId: string, paneId: string, conversation: Pick<ConversationResponse, "source" | "cursor" | "turns">): void {
  const key = tabLabelKey(machineId, paneId);
  if (conversation.source === "scrollback") { untranscribed.add(key); return; }
  untranscribed.delete(key);
  if (conversation.cursor !== null) return;
  const first = firstPromptOf(conversation.turns);
  if (first !== null) learnTabLabel(machineId, paneId, first);
}

/**
 * A message sent from Chat: it names the tab only where no transcript will say which message came
 * first. A pane with one learns its line from it instead, read from the beginning.
 */
export function learnFromSend(machineId: string, paneId: string, text: string): void {
  if (untranscribed.has(tabLabelKey(machineId, paneId))) learnTabLabel(machineId, paneId, text);
}

/** The text of a conversation's first message, when the turns start at its beginning; null when it has none with words yet. */
export function firstPromptOf(turns: readonly ConversationTurn[]): string | null {
  const first = turns.find((turn) => turn.role === "user" && turn.parts.some((part) => part.kind === "text" && part.text.trim() !== ""));
  if (!first) return null;
  return first.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join("\n");
}
