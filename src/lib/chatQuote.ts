import { composerDrafts } from "./composerDraft.ts";
import { quoteBlock } from "./replyComments.ts";

/**
 * Quote a selection into the composer (as Antigravity does): the selected words of a reply go into
 * the pane's draft as a Markdown `> ` blockquote with a blank line after it, after whatever the
 * draft holds, and nothing is sent. Quotes stack in the order they were taken.
 */
export function draftWithQuote(draft: string, quote: string): string {
  if (quote.trim() === "") return draft;
  const block = quoteBlock(quote);
  const head = draft.replace(/\s+$/, "");
  return `${head === "" ? "" : `${head}\n\n`}${block}\n\n`;
}

const draftKeyOf = (paneKey: string): string => `ovis:composer-draft:${paneKey}`;
const listeners = new Map<string, Set<() => void>>();

/** The pane's composer takes the keyboard, its caret after the draft, once a quote went into it. */
export function onQuoted(paneKey: string, listener: () => void): () => void {
  let set = listeners.get(paneKey);
  if (set === undefined) listeners.set(paneKey, set = new Set());
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(paneKey);
  };
}

/**
 * Puts `quote` into the draft of the pane `paneKey` (its `paneStorageId`) and hands the keyboard to
 * its composer. The draft goes to an agent alone from then on, as a draft carrying comments does
 * (#511): a shell would read its `>` lines as redirects.
 */
export function quoteIntoComposer(paneKey: string, quote: string): void {
  const key = draftKeyOf(paneKey);
  const next = draftWithQuote(composerDrafts.read(key).text, quote);
  if (next === composerDrafts.read(key).text) return;
  composerDrafts.markAgentOnly(key);
  composerDrafts.set(key, next);
  for (const listener of listeners.get(paneKey) ?? []) listener();
}
