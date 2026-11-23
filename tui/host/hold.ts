/**
 * How the screen tells the process that started it (`ovis tui`'s launcher, scripts/plugin-tui.ts) which of the
 * terminal's modes it holds. A screen that dies by a signal cannot give them back, and the launcher must undo exactly
 * what is held: nothing of a screen that never got as far as its modes, or that had undone them already (a stop from
 * its shell). The launcher names a file of its own in the screen's environment (SCREEN_HOLD); the screen writes what it
 * holds there before it turns the modes on and again once they are undone, so the file never says less than the
 * terminal holds, but for the instant of a stop from the shell, which says "none" just before its leave bytes
 * (tui/host/guard.ts `stopped`). A screen started without it tells nobody.
 */
import { openSync, readFileSync, writeSync } from "node:fs";
import type { Held } from "./guard.ts";

/** Where the launcher hands the screen its hold file. */
export const SCREEN_HOLD = "OVIS_TUI_HOLD";

/** What the file holds for each: one byte, so that saying it is one write. */
const BYTES: Readonly<Record<Held, string>> = { none: "0", modes: "1", "modes+watch": "2" };

/**
 * The hold file, opened once: what it returns writes what is held now over what it said before, in one write to the
 * open file. A file that cannot be opened or written tells nobody, and must not end the screen.
 */
export function openHold(file: string): (held: Held) => void {
  let fd: number;
  try { fd = openSync(file, "w"); } catch { return () => undefined; }
  return (held) => {
    try { writeSync(fd, BYTES[held], 0); } catch { /* nobody is told */ }
  };
}

/** What the file says is held; nothing when it is not there or says anything else. */
export function readHold(file: string): Held {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return "none"; }
  return text === BYTES.modes ? "modes" : text === BYTES["modes+watch"] ? "modes+watch" : "none";
}
