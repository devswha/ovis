import { useEffect, useRef, useState, type RefObject } from "react";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { splitTurn, visibleWorkParts } from "../lib/workBlocks.ts";

const POP_MS = 4000;

/** A streamed reply's placeholder stays in Working until its first visible content. */
export function withoutEmptyLiveTurn(turns: ConversationTurn[], streaming: boolean, showThinking: boolean): ConversationTurn[] {
  const last = turns.at(-1);
  const streamed = streaming && last?.role === "assistant" ? splitTurn(last.parts) : null;
  return streamed !== null && streamed.answer.length === 0 && visibleWorkParts(streamed.work, showThinking).length === 0 ? turns.slice(0, -1) : turns;
}

/** Optional send motion is separate from the upstream accepted-send bookkeeping. */
export function useSendMotion(sentKey: number, shownCount: RefObject<number>, follow: () => void, enabled: boolean): number | null {
  const seen = useRef(sentKey);
  const [from, setFrom] = useState<number | null>(null);
  useEffect(() => {
    if (seen.current === sentKey) return;
    seen.current = sentKey;
    if (!enabled) return;
    setFrom(shownCount.current);
    follow();
  }, [sentKey, shownCount, follow, enabled]);
  useEffect(() => {
    if (from === null) return;
    const timer = setTimeout(() => setFrom(null), POP_MS);
    return () => clearTimeout(timer);
  }, [from]);
  return enabled ? from : null;
}
