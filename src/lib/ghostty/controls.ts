/**
 * When libghostty alone parses a pane's output (overlay `only`), xterm still encodes the keys, paste, mouse and focus
 * reports, answers the program's questions about the terminal, places the IME's composition and its helper textarea
 * at the cursor, and hands OSC 52 to the clipboard. Those depend on a few sequences of the output and on where the
 * cursor is, not on the text. The scanner picks the sequences out of the stream, whole even when a frame splits one,
 * so xterm parses those bytes alone:
 *
 * - DEC private modes (`CSI ? … h/l`): cursor keys, bracketed paste, mouse tracking and format, focus reports, the
 *   alternate screen (which buffer xterm says is active), cursor visibility and the rest of xterm's mode flags
 * - modifyOtherKeys (`CSI > … m`), which useTerminalMount follows for Ctrl+Enter
 * - the questions xterm answers: device attributes (`CSI c`, `CSI > c`, `CSI = c`), status and cursor reports
 *   (`CSI n`, `CSI ? n`), mode reports (`CSI … $ p`), the version (`CSI > q`) and the cell and window sizes (`CSI … t`)
 * - the resets that put the modes back: RIS (`ESC c`) and DECSTR (`CSI ! p`)
 * - OSC 52 (clipboard) and the colour questions OSC 10/11/12 `?`
 *
 * Everything else (text, styles, cursor moves, hyperlinks, titles, pictures) goes to libghostty alone. xterm's cursor
 * is put where libghostty's is after each write and before each question, so a cursor report and the IME's
 * composition are where the program's cursor is.
 */

const GROUND = 0, ESC = 1, CSI = 2, OSC = 3, STRING = 4, STRING_ESC = 5, OSC_ESC = 6;
/** an OSC longer than this that is not OSC 52 is skipped unread (a title, a hyperlink, a picture) */
const OSC_HEAD = 8;

/** what xterm takes of a CSI sequence (`body` is everything after `ESC [`): "mode", "question", or nothing */
function csiKind(body: string): "mode" | "question" | null {
  const final = body[body.length - 1]!;
  const prefix = body[0]!;
  if (final === "p") return body === "!p" ? "mode" : body.endsWith("$p") ? "question" : null;
  // DEC private modes and ANSI ones (insert mode 4, new-line mode 20): xterm keeps both, and reports them
  if ((final === "h" || final === "l") && (prefix === "?" || /^[\d;]+[hl]$/.test(body))) return "mode";
  if (prefix === ">" && final === "m") return "mode";
  if (final === "c" || final === "n") return "question";
  if (final === "q") return prefix === ">" ? "question" : null;
  if (final === "t") return /^(14|16|18)t$/.test(body) ? "question" : null;
  return null;
}

const forwardsOsc = (body: string): boolean => {
  const semi = body.indexOf(";");
  const id = semi === -1 ? body : body.slice(0, semi);
  if (id === "52") return true;
  return (id === "10" || id === "11" || id === "12") && body.slice(semi + 1) === "?";
};

/** A stretch of the stream up to `end` (an index in the text), with what xterm takes of it; `question` ends it. */
export interface ControlPiece { end: number; controls: string; question: string | null }

/** `streaming()`: an OSC 52 is open in what xterm was given, so nothing else may go to xterm before it ends */
export type ControlScanner = ((text: string) => ControlPiece[]) & { streaming(): boolean };

/** the sequences xterm takes from each piece of text, the state carried from one call to the next */
export function controlScanner(): ControlScanner {
  let state = GROUND;
  let seq = "";
  let keep = true;
  // an OSC 52 goes to xterm as it comes, not once whole: a frame that opens it and one that ends it are each seen
  // owning it, as they are when xterm parses everything (the clipboard's replay guard reads xterm's OSC state)
  let streaming = false;
  const scanner = (text: string): ControlPiece[] => {
    const pieces: ControlPiece[] = [];
    let out = "";
    let at = 0;
    const length = text.length;
    while (at < length) {
      if (state === GROUND) {
        const next = text.indexOf("\x1b", at);
        if (next === -1) break;
        state = ESC;
        at = next + 1;
        continue;
      }
      const ch = text[at]!;
      const code = ch.charCodeAt(0);
      at++;
      switch (state) {
        case ESC:
          if (ch === "[") { state = CSI; seq = ""; }
          else if (ch === "]") { state = OSC; seq = ""; keep = true; streaming = false; }
          else if (ch === "P" || ch === "_" || ch === "^" || ch === "X") state = STRING;
          else if (ch === "c") { out += "\x1bc"; state = GROUND; }
          // the keypad's application and numeric modes (DECKPAM, DECKPNM), which xterm keeps for its keys
          else if (ch === "=" || ch === ">") { out += `\x1b${ch}`; state = GROUND; }
          else if (ch === "\x1b") state = ESC;
          else state = GROUND;
          break;
        case CSI:
          if (code === 0x1b) { state = ESC; break; }
          if (code === 0x18 || code === 0x1a) { state = GROUND; break; }
          if (code < 0x20) break;
          seq += ch;
          if (code >= 0x40 && code <= 0x7e) {
            const kind = csiKind(seq);
            if (kind === "mode") out += `\x1b[${seq}`;
            else if (kind === "question") { pieces.push({ end: at, controls: out, question: `\x1b[${seq}` }); out = ""; }
            state = GROUND;
          }
          break;
        case OSC:
          if (code === 0x07) {
            if (streaming) out += "\x07";
            else if (keep && forwardsOsc(seq)) out += `\x1b]${seq}\x07`;
            state = GROUND;
          } else if (code === 0x1b) state = OSC_ESC;
          else if (code === 0x18 || code === 0x1a) { if (streaming) out += ch; state = GROUND; }
          else if (streaming) out += ch;
          else if (keep) {
            seq += ch;
            if (seq === "52;") { streaming = true; out += "\x1b]52;"; }
            else if (seq.length === OSC_HEAD && !seq.startsWith("52;")) { keep = false; seq = ""; }
          }
          break;
        case OSC_ESC:
          if (streaming) out += ch === "\\" ? "\x1b\\" : "\x1b";
          else if (ch === "\\" && keep && forwardsOsc(seq)) out += `\x1b]${seq}\x1b\\`;
          // ESC ends the string either way; anything but `\` starts a new sequence
          if (ch === "\\") state = GROUND;
          else { state = ESC; at--; }
          break;
        case STRING:
          if (code === 0x07 || code === 0x18 || code === 0x1a) state = GROUND;
          else if (code === 0x1b) state = STRING_ESC;
          break;
        case STRING_ESC:
          if (ch === "\\") state = GROUND;
          else { state = ESC; at--; }
          break;
      }
    }
    pieces.push({ end: length, controls: out, question: null });
    return pieces;
  };
  return Object.assign(scanner, { streaming: () => streaming && state !== GROUND });
}

export interface ControlsEngine {
  write(data: string | Uint8Array): void;
  screenCursor(): { x: number; y: number };
}

/**
 * The write for a terminal whose output libghostty alone parses: `engine` takes every byte, and `xterm` (its own
 * write, whose callback still acknowledges the frame) the controls the scanner picks, with its cursor put where the
 * engine's is.
 */
export function controlsWriter(engine: ControlsEngine, xterm: (data: string, callback?: () => void) => void,
  scan: ControlScanner = controlScanner()): (data: string | Uint8Array, callback?: () => void) => void {
  const decoder = new TextDecoder();
  const cursorAt = (): string => { const { x, y } = engine.screenCursor(); return `\x1b[${y + 1};${x + 1}H`; };
  return (data, callback) => {
    const text = typeof data === "string" ? data : decoder.decode(data, { stream: true });
    const pieces = scan(text);
    let out = "";
    // bytes are fed as the text decoded from them, so a character split between two writes reaches the engine once
    if (pieces.length === 1 && typeof data === "string") {
      engine.write(data);
      out = pieces[0]!.controls;
    } else {
      // a question is answered from the cursor where the program asked it: the engine takes the text up to it first
      let from = 0;
      for (const piece of pieces) {
        engine.write(text.slice(from, piece.end));
        from = piece.end;
        out += piece.controls;
        if (piece.question !== null) out += (scan.streaming() ? "" : cursorAt()) + piece.question;
      }
    }
    // xterm's cursor follows libghostty's, unless an OSC 52 it was given is still open (a CUP would end it)
    xterm(scan.streaming() ? out : out + cursorAt(), callback);
  };
}

/**
 * A stream to hand xterm whole after it took only its controls (libghostty gave up): every byte but the questions it
 * already answered, so the program gets no second reply. The caller resets xterm first, so its modes come again.
 */
export function withoutQuestions(chunks: readonly (string | Uint8Array)[]): string {
  const scan = controlScanner();
  const decoder = new TextDecoder();
  let out = "";
  for (const chunk of chunks) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let from = 0;
    for (const piece of scan(text)) {
      if (piece.question === null) { out += text.slice(from); break; }
      out += text.slice(from, Math.max(from, piece.end - piece.question.length));
      from = piece.end;
    }
  }
  return out;
}
