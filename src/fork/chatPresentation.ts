import { useEffect, useRef } from "react";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { splitTurn, visibleWorkParts } from "../lib/workBlocks.ts";

/** A streamed reply's placeholder stays in Working until its first visible content. */
export function withoutEmptyLiveTurn(turns: ConversationTurn[], streaming: boolean, showThinking: boolean): ConversationTurn[] {
  const last = turns.at(-1);
  const streamed = streaming && last?.role === "assistant" ? splitTurn(last.parts) : null;
  return streamed !== null && streamed.answer.length === 0 && visibleWorkParts(streamed.work, showThinking).length === 0 ? turns.slice(0, -1) : turns;
}

/** Optional send follow is separate from the upstream accepted-send bookkeeping. */
export function useSendMotion(sentKey: number, follow: () => void, enabled: boolean): void {
  const seen = useRef(sentKey);
  useEffect(() => {
    if (seen.current === sentKey) return;
    seen.current = sentKey;
    if (enabled) follow();
  }, [sentKey, follow, enabled]);
}
