import { useEffect, useRef, useState } from "react";

import type { PendingMessage } from "../../../shared/protocol.ts";

/** how long a Pi receipt waits unseen: Pi's transcript usually confirms it first, and the chat shows the message once */
export const RECEIPT_QUIET_MS = 1500;

const waitingReceipt = (message: Pick<PendingMessage, "error">): boolean => message.error?.code === "pi_transcript_pending";

/**
 * The pending rows to draw (PaneTerminal.tsx): a Pi receipt still waiting for its transcript stays out of sight for
 * its first RECEIPT_QUIET_MS here, so a send Pi records at once pops in the chat alone instead of twice for a second.
 * One that waits longer, and every other row, shows as before.
 */
export function useQuietReceipts<T extends Pick<PendingMessage, "id" | "error">>(rows: readonly T[]): readonly T[] {
  const seen = useRef(new Map<string, number>());
  const [, wake] = useState(0);
  const now = Date.now();
  for (const row of rows) if (waitingReceipt(row) && !seen.current.has(row.id)) seen.current.set(row.id, now);
  for (const id of seen.current.keys()) if (!rows.some((row) => row.id === id)) seen.current.delete(id);
  const quiet = (row: T): boolean => waitingReceipt(row) && now - seen.current.get(row.id)! < RECEIPT_QUIET_MS;
  const next = Math.min(...rows.filter(quiet).map((row) => seen.current.get(row.id)! + RECEIPT_QUIET_MS));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => wake((tick) => tick + 1), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [next]);
  return rows.some(quiet) ? rows.filter((row) => !quiet(row)) : rows;
}
