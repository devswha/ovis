import type { HcConnection } from "./connection.ts";
import { SEEN_LABEL, seenTurnOf } from "./snapshot.ts";

/**
 * Tells every Herdr client that a person looked at a terminal's agent (herdr-app docs/labels.md):
 * `herdr.seen` becomes the terminal's turn, so a finish read in Ovis is read in the Herdr app too.
 * Written only to raise it, or where it is missing so a terminal started elsewhere joins; called
 * once per finish a browser presented (server/seen.ts), never on every update.
 */
export async function markSeen(hc: HcConnection, address: string): Promise<void> {
  const record = await hc.call("terminal.get", { terminal: address });
  if (record.state !== "live") return;
  const turn = record.turn ?? 0;
  const seen = seenTurnOf(record.labels);
  if (seen !== null && seen >= turn) return;
  await hc.call("terminal.label", { terminal: address, labels: { [SEEN_LABEL]: String(turn) } });
}
