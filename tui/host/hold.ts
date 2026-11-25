/**
 * How the screen tells the process that started it (`ovis tui`'s launcher, scripts/plugin-tui.ts) which of the
 * terminal's modes it holds. A screen that dies by a signal cannot give them back, and the launcher must undo exactly
 * what is held: nothing of a screen that never got as far as its modes, or that had undone them already (a stop from
 * its shell). The launcher makes a file of its own, saying "none", and names it in the screen's environment
 * (SCREEN_HOLD); the screen writes what it holds there before it turns the modes on and again once they are undone, so
 * the file never says less than the terminal holds, but for the instant of a stop from the shell, which says
 * "stopping" just before its leave bytes (tui/host/guard.ts `stopped`). A screen started without it tells nobody.
 *
 * The file also says who stops the job at a stop from outside (SIGTSTP to the whole job, as a shell sends it). A screen
 * that holds its modes, or says "stopping", gives the terminal back first and then stops the whole job, the launcher
 * with it, in one kill: the launcher must not stop on its own before, or the shell would take the terminal back and
 * could send its `fg` before the screen had stopped, and the screen would stop after it and stay stopped. A screen that
 * holds nothing stops at the signal itself, and the launcher stops as well.
 */
import { openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import type { Held, HoldState } from "./guard.ts";

/** Where the launcher hands the screen its hold file. */
export const SCREEN_HOLD = "OVIS_TUI_HOLD";

/** What the file holds for each: one byte, so that saying it is one write. */
export const HOLD_BYTES: Readonly<Record<HoldState, string>> = { none: "0", modes: "1", "modes+watch": "2", stopping: "3" };

/** What the file says when the screen itself stops the whole job at a stop from outside. */
export const STOPS_JOB_BYTES: readonly string[] = [HOLD_BYTES.modes, HOLD_BYTES["modes+watch"], HOLD_BYTES.stopping];

/** Makes the file, saying that nothing is held; false where it cannot be made or read back, and so cannot be handed to a screen. */
export function makeHold(file: string): boolean {
  try {
    writeFileSync(file, HOLD_BYTES.none, { mode: 0o600 });
    return readFileSync(file, "utf8") === HOLD_BYTES.none;
  } catch { return false; }
}

/**
 * The hold file, opened once: what it returns writes what is held now over what it said before, in one write to the
 * open file; null when it cannot be opened (the screen then tells nobody, and stops only itself). A write that fails
 * tells nobody, and must not end the screen.
 */
export function openHold(file: string): ((held: HoldState) => void) | null {
  let fd: number;
  try { fd = openSync(file, "w"); } catch { return null; }
  return (held) => {
    try { writeSync(fd, HOLD_BYTES[held], 0); } catch { /* nobody is told */ }
  };
}

/** Whether the screen stops the whole job itself at a stop from outside; not when the file is not there. */
export function stopsJob(file: string): boolean {
  try { return STOPS_JOB_BYTES.includes(readFileSync(file, "utf8")); } catch { return false; }
}

/** What the file says is held; nothing when it is not there or says anything else ("stopping": the leave bytes follow). */
export function readHold(file: string): Held {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return "none"; }
  return text === HOLD_BYTES.modes ? "modes" : text === HOLD_BYTES["modes+watch"] ? "modes+watch" : "none";
}
