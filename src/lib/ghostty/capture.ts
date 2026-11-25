import type { Terminal } from "@xterm/xterm";
import type { HerdrSocket } from "../ws.ts";
import type { GhosttyOverlay } from "./overlay.ts";

/** bytes held for libghostty while its module loads: a herdr-core history replay fits many times over */
const HELD_BYTES_MAX = 32 * 1024 * 1024;
/** "on" or "off": whether libghostty alone parses this browser's terminals (overlay `only`); off unless set */
export const GHOSTTY_ONLY_KEY = "ovis:ghostty-only";

function ghosttyOnly(): boolean {
  // a browser that refuses storage leaves the default
  try { return globalThis.localStorage?.getItem(GHOSTTY_ONLY_KEY) === "on"; } catch { return false; }
}

export function captureForGhostty(term: Terminal, socket: HerdrSocket, host: HTMLElement): () => void {
  let held: (string | Uint8Array)[] | null = [];
  let heldBytes = 0;
  let overlay: GhosttyOverlay | null = null;
  let stopped = false;
  const write = term.write.bind(term);
  const reset = term.reset.bind(term);
  const unwrap = (): void => {
    if (term.write !== holdingWrite) return;
    term.write = write;
    term.reset = reset;
  };
  const giveUp = (): void => {
    held = null;
    unwrap();
  };
  const holdingWrite: Terminal["write"] = (data, callback) => {
    if (held) {
      heldBytes += data.length;
      if (heldBytes > HELD_BYTES_MAX) giveUp();
      else held.push(data);
    }
    // xterm owns the screen and answers queries until there is a Ghostty cursor to use.
    write(data, callback);
  };
  term.write = holdingWrite;
  term.reset = () => {
    if (held) { held.length = 0; heldBytes = 0; }
    reset();
  };

  let decided = false;
  const decide = (): void => {
    if (decided || stopped || !socket.featuresListed()) return;
    decided = true;
    const only = ghosttyOnly();
    const takeBacklog = (): (string | Uint8Array)[] | null => {
      if (stopped || !held) return null;
      const taken = held;
      held = null;
      unwrap();
      return taken;
    };
    void import("./overlay.ts")
      .then(({ attachGhosttyOverlay }) => held ? attachGhosttyOverlay(term, host, takeBacklog, only) : null)
      .then((attached) => {
        if (!attached) return;
        if (stopped) { attached.dispose(false); return; }
        overlay = attached;
      }, (error: unknown) => {
        giveUp();
        console.warn("libghostty could not draw this terminal; xterm draws it", error);
      });
  };
  const off = socket.on((message) => {
    if (message.type === "features" || message.type === "snapshot") decide();
  });
  decide();
  return () => {
    stopped = true;
    off();
    held = null;
    unwrap();
    overlay?.dispose(false);
  };
}
