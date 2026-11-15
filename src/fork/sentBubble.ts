import { useEffect, useRef } from "react";
import type { CommandOutcome, ConversationTurn } from "../../shared/protocol.ts";
import type { WaitingSend } from "../lib/sentWaiting.ts";

/**
 * Animated replies: a message sent from here is one chat row from the server's receipt on. The row
 * is keyed by its send (`sendRowKey`), the transcript's own turn takes that key over once it matches
 * the send (`adoptSend`, called as the send settles), so React keeps the same element and the bubble
 * neither remounts nor pops a second time. Only these rows pop, and each once: a row the list
 * mounts again (a scroll back) finds its key in `popped`.
 */

/** The row of a send, by its pane and id: a transcript turn never has this key unless it was adopted. */
export const sendRowKey = (send: Pick<WaitingSend, "pane" | "id">): string => `send:${send.pane}:${send.id}`;

const turnWords = (turn: ConversationTurn): string => turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join(" ");

const turns = new WeakMap<WaitingSend, ConversationTurn>();
/** The send as the user turn the transcript will hold, in place until it does. */
export function sendTurn(send: WaitingSend): ConversationTurn {
  let turn = turns.get(send);
  if (turn === undefined) {
    turn = { role: "user", ts: new Date(send.at).toISOString(), parts: [{ kind: "text", text: send.text }] };
    turns.set(send, turn);
  }
  return turn;
}

/**
 * The outcome each send owns, so the send's row carries its chip rather than a second row beside it.
 * Its own is one the chat had not read as the text left (`send.known`, as lib/terminalPeek.ts
 * sentOutcome tells a peek's) with its text; the sends go oldest first and each takes the oldest
 * such outcome no earlier send took. A send that left before the chat read any outcomes owns none.
 */
export function claimOutcomes(sends: readonly WaitingSend[], outcomes: readonly CommandOutcome[]): Map<number, CommandOutcome> {
  const owned = new Map<number, CommandOutcome>();
  const taken = new Set<string>();
  for (const send of sends) {
    if (send.known === undefined) continue;
    const known = new Set(send.known);
    const text = send.text.trim();
    const own = outcomes.find((outcome) => !known.has(outcome.id) && !taken.has(outcome.id) && outcome.text.trim() === text);
    if (own === undefined) continue;
    taken.add(own.id);
    owned.set(send.id, own);
  }
  return owned;
}

const ADOPTED_PER_PANE = 50;
/** per pane: the row key a transcript turn (by its time) took over from its send */
const adopted = new Map<string, { ts: string; words: string; key: string }[]>();

/** The send's turn is in the transcript: that row keeps the send's key. */
export function adoptSend(pane: string, send: WaitingSend, turn: ConversationTurn): void {
  if (turn.ts === null) return;
  const list = adopted.get(pane) ?? [];
  list.push({ ts: turn.ts, words: turnWords(turn), key: sendRowKey(send) });
  if (list.length > ADOPTED_PER_PANE) list.shift();
  adopted.set(pane, list);
}

/**
 * The row key of a turn that took a send's over, each key given to one turn only (`used`). Only a
 * send this page drew as a row has one (`popped` holds it): a send made with the setting off never
 * gets a row key later, and with it the pop.
 */
export function adoptedKey(pane: string, turn: ConversationTurn, used: Set<string>): string | undefined {
  if (turn.role !== "user" || turn.ts === null) return undefined;
  const entry = adopted.get(pane)?.find((item) => item.ts === turn.ts && !used.has(item.key) && popped.has(item.key) && item.words === turnWords(turn));
  if (entry === undefined) return undefined;
  used.add(entry.key);
  return entry.key;
}

/** rows that have popped, by row key */
const popped = new Set<string>();

/**
 * Whether the row pops: only a send's own row, and only on its first mount. A row that popped keeps
 * its class while it stays mounted (the animation runs on, and a class that stays replays nothing).
 * A row mounted with the setting off has had its chance too: switching it on later pops nothing, nor
 * does switching it off and on again, which would replay the animation on a row that already ran it.
 */
export function useSendPop(rowKey: string, enabled: boolean): boolean {
  const mine = useRef(false);
  const pops = enabled && rowKey.startsWith("send:") && (mine.current || !popped.has(rowKey));
  useEffect(() => {
    if (!rowKey.startsWith("send:")) return;
    if (pops) mine.current = true;
    if (!enabled) mine.current = false;
    if (pops || !enabled) popped.add(rowKey);
  });
  return pops;
}

const RETIRED_MAX = 200;
/** the sends a restored copy took back, by row key: kept for the send's life, across views of the pane */
const retired = new Set<string>();

/**
 * The sends the chat draws as rows: not a queued delivery (it stays in the footer), and not one a
 * restored copy took back. That one is retired for good (`retired` outlives the view): the restored
 * text clearing later, or the chat mounting again, must not bring its bubble back.
 */
export function rowSendsOf(sends: readonly WaitingSend[], restored: string | null, same: (a: string, b: string) => boolean): WaitingSend[] {
  if (restored !== null) {
    for (const send of sends) if (same(send.text, restored)) retired.add(sendRowKey(send));
    while (retired.size > RETIRED_MAX) retired.delete(retired.values().next().value!);
  }
  return sends.filter((send) => send.queued !== true && !retired.has(sendRowKey(send)));
}

/** The index of a row in the timeline's rows: a send's row is only there, any other is a slot's too. */
export function rowIndexOf(key: string, timelineKeys: readonly string[], slotKeys: readonly string[]): number {
  return (key.startsWith("send:") ? timelineKeys : slotKeys).indexOf(key);
}

/** Forget the memory of popped rows and adoptions (tests). */
export function resetSendBubbles(): void {
  popped.clear();
  adopted.clear();
  retired.clear();
}
