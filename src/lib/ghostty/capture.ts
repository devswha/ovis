import type { Terminal } from "@xterm/xterm";
import type { HerdrSocket } from "../ws.ts";
import { controlScanner, withoutQuestions } from "./controls.ts";
import type { GhosttyOverlay } from "./overlay.ts";

/** bytes held for libghostty while its module loads: a herdr-core history replay fits many times over */
const HELD_BYTES_MAX = 32 * 1024 * 1024;
/** "on" or "off": whether libghostty alone parses this browser's terminals (overlay `only`); off unless set */
export const GHOSTTY_ONLY_KEY = "ovis:ghostty-only";

function ghosttyOnly(): boolean {
  // a browser that refuses storage leaves the default
  try { return globalThis.localStorage?.getItem(GHOSTTY_ONLY_KEY) === "on"; } catch { return false; }
}

/** `picturesWanted`: whether this terminal is to draw iTerm2 and sixel pictures (Pictures in the terminal), which xterm draws */
export function captureForGhostty(term: Terminal, socket: HerdrSocket, host: HTMLElement, picturesWanted: () => boolean): () => void {
  let held: (string | Uint8Array)[] | null = [];
  let heldBytes = 0;
  let overlay: GhosttyOverlay | null = null;
  let stopped = false;
  // with `only` (decided when the server says what it is), xterm takes the controls of what libghostty is to draw
  // (controls.ts). iTerm2 and sixel pictures are drawn by xterm (overlay.ts): a terminal that shows them keeps xterm's
  // full parse
  let only = false;
  const scan = controlScanner();
  const decoder = new TextDecoder();
  const controlsOf = (data: string | Uint8Array): string =>
    scan(typeof data === "string" ? data : decoder.decode(data, { stream: true })).map((piece) => piece.controls + (piece.question ?? "")).join("");
  const write = term.write.bind(term);
  const reset = term.reset.bind(term);
  const unwrap = (): void => {
    if (term.write !== holdingWrite) return;
    term.write = write;
    term.reset = reset;
  };
  // xterm saw only the controls of `chunks`: it parses them whole after all, from a reset (their modes come again)
  // and without the questions it already answered
  const parseWhole = (chunks: (string | Uint8Array)[]): void => {
    reset();
    write(withoutQuestions(chunks));
  };
  const giveUp = (): void => {
    if (only && held) parseWhole(held);
    held = null;
    unwrap();
  };
  const holdingWrite = ((data: string | Uint8Array, callback?: () => void) => {
    if (held) {
      held.push(data);
      heldBytes += data.length;
      // the chunk that crosses the limit is in what xterm takes whole
      if (heldBytes > HELD_BYTES_MAX) { giveUp(); callback?.(); return; }
    }
    write(only && held ? controlsOf(data) : data, callback);
  }) as Terminal["write"];
  term.write = holdingWrite;
  term.reset = () => {
    if (held) { held.length = 0; heldBytes = 0; }
    reset();
  };

  let decided = false;
  const decide = (): void => {
    if (decided || stopped || !socket.featuresListed()) return;
    decided = true;
    only = ghosttyOnly() && !picturesWanted();
    let taken: (string | Uint8Array)[] | null = null;
    const takeBacklog = (): (string | Uint8Array)[] | null => {
      if (stopped || !held) return null;
      taken = held;
      held = null;
      unwrap();
      return taken;
    };
    // libghostty took the backlog and does not draw after all: xterm, which saw only its controls, parses it whole
    const handBack = (): void => {
      if (only && taken && !stopped) parseWhole(taken);
      taken = null;
    };
    void import("./overlay.ts")
      .then(({ attachGhosttyOverlay }) => attachGhosttyOverlay(term, host, takeBacklog, only ? scan : null))
      .then((attached) => {
        if (!attached) { handBack(); return; }
        taken = null;
        if (stopped) { attached.dispose(false); return; }
        overlay = attached;
      }, (error: unknown) => {
        handBack();
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
