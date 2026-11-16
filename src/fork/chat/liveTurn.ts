/**
 * The message pi is writing (conversation-live, from pi's ovis-model extension), drawn as part of
 * the chat until the transcript holds it. Its turn's `ts` is when the message began and the line
 * pi writes for the finished message is stamped later, so a last turn ending at or after it holds
 * the message itself.
 */
import { useEffect, useState } from "react";

import type { ConversationPart, ConversationTurn } from "../../../shared/protocol.ts";
import { stablePrefix, wordCut } from "./streamReveal.ts";

/** a live message whose file is gone stays this long at most while the transcript is read */
export const LIVE_HOLD_MS = 5000;

export function liveLanded(turns: readonly ConversationTurn[], live: ConversationTurn): boolean {
  const last = turns.at(-1);
  const began = Date.parse(live.ts ?? "");
  const ended = Date.parse(last?.end_ts ?? last?.ts ?? "");
  return Number.isFinite(began) && Number.isFinite(ended) && ended >= began;
}

/** The turns with the live message's parts after them: on the last turn when it is the agent's, else a turn of its own. */
export function withLiveTurn(turns: ConversationTurn[], live: ConversationTurn | null): ConversationTurn[] {
  if (live === null || live.parts.length === 0 || liveLanded(turns, live)) return turns;
  const last = turns.at(-1);
  if (last?.role !== "assistant") return [...turns, live];
  return [...turns.slice(0, -1), { ...last, end_ts: live.ts ?? last.end_ts, parts: [...last.parts, ...live.parts] }];
}

type Streamed = Extract<ConversationPart, { kind: "text" | "thinking" }>;

/** The part a reply streams into: the last turn's last text (or thinking, where it shows) part, while that turn is the agent's. */
function streamedPart(turns: readonly ConversationTurn[], showThinking: boolean): Streamed | null {
  const last = turns.at(-1);
  const part = last?.parts.at(-1);
  if (last?.role !== "assistant" || part === undefined || !(part.kind === "text" || (showThinking && part.kind === "thinking"))) return null;
  return part;
}

/**
 * The turns with a streaming reply cut to its whole words, short of any markdown still open
 * (lib/streamReveal.ts), so a half-written word, `**bold` or link never shows. Each new word
 * fades in as it is drawn (wordFade.ts). The transcript's copy of a message (withLiveTurn let it
 * through) and a message that is done (`live` gone) are drawn whole.
 */
export function heldBackTurns(turns: ConversationTurn[], live: ConversationTurn | null, showThinking: boolean): ConversationTurn[] {
  const part = live === null ? null : streamedPart(turns, showThinking);
  if (part === null || part !== live?.parts.at(-1)) return turns;
  const drawn = stablePrefix(part.text, wordCut(part.text, part.text.length, false), false);
  if (drawn === part.text.length) return turns;
  const last = turns.at(-1)!;
  const kept = last.parts.slice(0, -1);
  return [...turns.slice(0, -1), { ...last, parts: drawn === 0 ? kept : [...kept, { ...part, text: part.text.slice(0, drawn) }] }];
}

/** The last live message, kept a while after its file goes: the transcript may not hold it yet. */
export function useHeldLive(live: ConversationTurn | null): ConversationTurn | null {
  const [held, setHeld] = useState(live);
  useEffect(() => {
    if (live !== null) { setHeld(live); return; }
    const timer = setTimeout(() => setHeld(null), LIVE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [live]);
  return live ?? held;
}
