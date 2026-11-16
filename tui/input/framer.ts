import { ESC_WAIT_MS, ESC_WAIT_SLOW_MS, PASTE_LIMIT_BYTES, REPLY_WAIT_MS, SEQUENCE_DROP_MS, SEQUENCE_LIMIT_BYTES } from "../model/deadlines.ts";
import { decodeControl, decodeCsi, decodeSs3, decodeString, typedKey, withAlt, type InputEvent, type Unstamped } from "./decode.ts";

/** What the host terminal was set up with, as far as it changes how its bytes are cut. */
interface HostModes {
  /** mouse reporting is on */
  mouse: boolean;
  /** the kitty keyboard flag is pushed */
  kitty: boolean;
  /** the tty's erase character is ^H, so 0x08 is Backspace rather than ctrl+h */
  eraseIsCtrlH: boolean;
}

type State = "ground" | "esc" | "csi" | "ss3" | "string" | "paste" | "utf8";

const ESC = 0x1b;
const PASTE_START = "200";
const PASTE_END = Uint8Array.from("\x1b[201~", (char) => char.charCodeAt(0));
const STRING_KINDS: Readonly<Record<number, "osc" | "dcs" | "apc">> = { 0x5d: "osc", 0x50: "dcs", 0x5f: "apc" };
/** the bytes of an X10 mouse report after `CSI M` */
const X10_REPORT_BYTES = 3;

const latin1 = (bytes: readonly number[]): string => String.fromCharCode(...bytes);
const utf8 = new TextDecoder();

/** How many continuation bytes a UTF-8 lead byte announces; 0 for a byte no character starts with. */
function continuationCount(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 1;
  if (lead >= 0xe0 && lead <= 0xef) return 2;
  if (lead >= 0xf0 && lead <= 0xf4) return 3;
  return 0;
}

/** The range the first continuation byte must fall in, which rules out overlong forms, surrogates and code points past U+10FFFF. */
function firstContinuation(lead: number): [number, number] {
  if (lead === 0xe0) return [0xa0, 0xbf];
  if (lead === 0xed) return [0x80, 0x9f];
  if (lead === 0xf0) return [0x90, 0xbf];
  if (lead === 0xf4) return [0x80, 0x8f];
  return [0x80, 0xbf];
}

/**
 * Cuts the bytes the host terminal sends into input events. It owns every wait of host input but reads
 * no clock: the caller passes its time with each read (`feed`), asks when the next wait ends
 * (`deadline`) and calls `tick` then. A read may end anywhere, inside a character or a sequence; the
 * events are the same however the bytes were cut, as long as no wait passes between the reads.
 * - A read that ends in a lone ESC, `ESC [` or `ESC O` waits ESC_WAIT_MS (ESC_WAIT_SLOW_MS while the host
 *   reports the mouse or has the kitty flag on) for the rest, then gives Escape, Alt+[ or Alt+O.
 * - A longer unfinished sequence never becomes a key: it is dropped as `unknown` SEQUENCE_DROP_MS after
 *   its first byte.
 * - An unfinished UTF-8 character waits for the next read, however late, and is never split.
 * - A bracketed paste is one event; no wait ends it, and past PASTE_LIMIT_BYTES it is refused whole.
 * - A reply's shape gives a `reply` only while the start probe waits (`expectReplies`), else `unknown`.
 */
export class Framer {
  private modes: HostModes = { mouse: false, kitty: false, eraseIsCtrlH: false };
  private state: State = "ground";
  private out: InputEvent[] = [];
  /** the next wait of a sequence in progress, an ESC or a longer one */
  private pending: number | undefined;
  private replyUntil: number | undefined;
  /** the bytes of the sequence in progress, at most SEQUENCE_LIMIT_BYTES of them */
  private seq: number[] = [];
  /** the sequence in progress outgrew SEQUENCE_LIMIT_BYTES, so its bytes are not all kept */
  private cutShort = false;
  private seqAt = 0;
  private stringKind: "osc" | "dcs" | "apc" = "osc";
  /** an ESC inside a string, which ends it when a backslash follows */
  private stringEscAt: number | undefined;
  private x10Left = 0;
  private text: number[] = [];
  private textAt = 0;
  private char: number[] = [];
  private charAt = 0;
  private charNeed = 0;
  private charAlt = false;
  private paste = { chunks: [] as Uint8Array[], size: 0, refused: false, endMatched: 0 };

  setModes(modes: Partial<HostModes>): void {
    this.modes = { ...this.modes, ...modes };
  }

  /** The start probe was sent at `now`: replies are read until its DA1 reply comes or REPLY_WAIT_MS pass. */
  expectReplies(now: number): void {
    this.replyUntil = now + REPLY_WAIT_MS;
  }

  /** When `tick` must next be called; undefined when no wait runs. */
  deadline(): number | undefined {
    if (this.pending === undefined) return this.replyUntil;
    if (this.replyUntil === undefined) return this.pending;
    return Math.min(this.pending, this.replyUntil);
  }

  /** The events of one read made at `now`, after those of any wait that ended by then. */
  feed(bytes: Uint8Array, now: number): InputEvent[] {
    this.expire(now);
    for (let i = 0; i < bytes.length;) {
      if (this.state === "paste") i = this.pasteBytes(bytes, i);
      else this.step(bytes[i++]!, now);
    }
    this.flushText();
    this.arm(now);
    return this.take();
  }

  tick(now: number): InputEvent[] {
    this.expire(now);
    return this.take();
  }

  private take(): InputEvent[] {
    const events = this.out;
    this.out = [];
    return events;
  }

  private emit(event: Unstamped, at: number): void {
    this.flushText();
    this.out.push({ ...event, at } as InputEvent);
    if (event.type === "reply" && event.kind === "deviceAttributes") this.replyUntil = undefined;
  }

  private emitUnknown(bytes: readonly number[], at: number): void {
    this.emit({ type: "unknown", raw: latin1(bytes) }, at);
  }

  private flushText(): void {
    if (!this.text.length) return;
    this.out.push({ type: "text", text: utf8.decode(Uint8Array.from(this.text)), at: this.textAt });
    this.text = [];
  }

  private pushText(bytes: readonly number[], at: number): void {
    if (!this.text.length) this.textAt = at;
    this.text.push(...bytes);
  }

  private begin(state: State, bytes: number[], at: number): void {
    this.state = state;
    this.seq = bytes;
    this.seqAt = at;
    this.cutShort = false;
  }

  private keep(byte: number): void {
    if (this.seq.length < SEQUENCE_LIMIT_BYTES) this.seq.push(byte);
    else this.cutShort = true;
  }

  private ground(): void {
    this.state = "ground";
    this.seq = [];
    this.cutShort = false;
    this.stringEscAt = undefined;
    this.x10Left = 0;
  }

  /** One byte outside a paste; a byte that ends a sequence it cannot belong to is read again in ground. */
  private step(byte: number, now: number): void {
    for (;;) {
      switch (this.state) {
        case "ground": return this.onGround(byte, now);
        case "esc": return this.onEsc(byte, now);
        case "utf8": if (this.onUtf8(byte)) return; break;
        case "csi": if (this.onCsi(byte)) return; break;
        case "ss3": if (this.onSs3(byte)) return; break;
        case "string": if (this.onString(byte, now)) return; break;
        case "paste": return;
      }
    }
  }

  private onGround(byte: number, now: number): void {
    if (byte >= 0x20 && byte < 0x7f) this.pushText([byte], now);
    else if (byte === ESC) this.begin("esc", [byte], now);
    else if (byte < 0x80) this.emit(decodeControl(byte, this.modes.eraseIsCtrlH), now);
    else if (continuationCount(byte)) this.beginChar(byte, now, false);
    else this.emitUnknown([byte], now);
  }

  private beginChar(lead: number, at: number, alt: boolean): void {
    this.state = "utf8";
    this.char = [lead];
    this.charAt = at;
    this.charNeed = continuationCount(lead);
    this.charAlt = alt;
  }

  private onEsc(byte: number, now: number): void {
    const at = this.seqAt;
    const kind = STRING_KINDS[byte];
    if (byte === ESC) {
      this.emit(typedEscape, at);
      this.begin("esc", [byte], now);
    } else if (byte === 0x5b) {
      this.keep(byte);
      this.state = "csi";
    } else if (byte === 0x4f) {
      this.keep(byte);
      this.state = "ss3";
    } else if (kind) {
      this.keep(byte);
      this.state = "string";
      this.stringKind = kind;
    } else if (byte >= 0x20 && byte < 0x7f) {
      this.ground();
      this.emit(typedKey(String.fromCharCode(byte), { alt: true }), at);
    } else if (byte < 0x80) {
      this.ground();
      this.emit(withAlt(decodeControl(byte, this.modes.eraseIsCtrlH)), at);
    } else if (continuationCount(byte)) {
      this.seq = [];
      this.beginChar(byte, at, true);
    } else {
      this.ground();
      this.emitUnknown([ESC, byte], at);
    }
  }

  /** Returns false when `byte` cut the character short and must be read again in ground. */
  private onUtf8(byte: number): boolean {
    const [low, high] = this.char.length === 1 ? firstContinuation(this.char[0]!) : [0x80, 0xbf];
    const prefix = this.charAlt ? [ESC] : [];
    if (byte < low || byte > high) {
      this.ground();
      this.emitUnknown([...prefix, ...this.char], this.charAt);
      return false;
    }
    this.char.push(byte);
    if (this.char.length <= this.charNeed) return true;
    this.ground();
    if (this.charAlt) this.emit(typedKey(utf8.decode(Uint8Array.from(this.char)), { alt: true }), this.charAt);
    else this.pushText(this.char, this.charAt);
    return true;
  }

  private onCsi(byte: number): boolean {
    if (this.x10Left > 0) {
      this.keep(byte);
      if (--this.x10Left === 0) this.finish(undefined);
      return true;
    }
    if (byte >= 0x20 && byte <= 0x3f) {
      this.keep(byte);
      return true;
    }
    if (byte < 0x40 || byte > 0x7e) {
      this.finish(undefined);
      return false;
    }
    this.keep(byte);
    const body = latin1(this.seq.slice(2, -1));
    const final = String.fromCharCode(byte);
    if (this.cutShort) this.finish(undefined);
    else if (body === "" && final === "M") this.x10Left = X10_REPORT_BYTES;
    else if (body === PASTE_START && final === "~") this.beginPaste();
    else this.finish(decodeCsi(body, final, this.replyUntil !== undefined));
    return true;
  }

  private onSs3(byte: number): boolean {
    if (byte < 0x40 || byte > 0x7e) {
      this.finish(undefined);
      return false;
    }
    this.keep(byte);
    this.finish(decodeSs3(String.fromCharCode(byte)));
    return true;
  }

  private onString(byte: number, now: number): boolean {
    if (this.stringEscAt !== undefined) {
      const escAt = this.stringEscAt;
      if (byte === 0x5c) {
        this.keep(ESC);
        this.keep(byte);
        this.finishString(2);
        return true;
      }
      this.finish(undefined);
      this.begin("esc", [ESC], escAt);
      return false;
    }
    if (byte === ESC) {
      this.stringEscAt = now;
      return true;
    }
    this.keep(byte);
    if (byte === 0x07) this.finishString(1);
    return true;
  }

  private finishString(terminator: number): void {
    const body = latin1(this.seq.slice(2, this.seq.length - terminator));
    this.finish(this.cutShort ? undefined : decodeString(this.stringKind, body, this.replyUntil !== undefined));
  }

  private finish(event: Unstamped | undefined): void {
    const bytes = this.seq, at = this.seqAt;
    this.ground();
    if (event) this.emit(event, at);
    else this.emitUnknown(bytes, at);
  }

  private beginPaste(): void {
    this.state = "paste";
    this.seq = [];
    this.paste = { chunks: [], size: 0, refused: false, endMatched: 0 };
  }

  /** Reads paste bytes from `i` on and returns where it stopped: at the end of the read or after the end mark. */
  private pasteBytes(bytes: Uint8Array, i: number): number {
    const paste = this.paste;
    while (i < bytes.length) {
      if (paste.endMatched > 0) {
        if (bytes[i] === PASTE_END[paste.endMatched]) {
          i++;
          if (++paste.endMatched === PASTE_END.length) {
            this.endPaste();
            return i;
          }
          continue;
        }
        // not the end mark after all: what looked like its start was data
        this.pasteData(PASTE_END.subarray(0, paste.endMatched));
        paste.endMatched = 0;
      }
      const esc = bytes.indexOf(ESC, i);
      const stop = esc === -1 ? bytes.length : esc;
      if (stop > i) this.pasteData(bytes.subarray(i, stop));
      if (esc === -1) return bytes.length;
      paste.endMatched = 1;
      i = esc + 1;
    }
    return i;
  }

  private pasteData(data: Uint8Array): void {
    const paste = this.paste;
    paste.size += data.length;
    if (paste.size > PASTE_LIMIT_BYTES) {
      paste.refused = true;
      paste.chunks = [];
    }
    if (!paste.refused) paste.chunks.push(data.slice());
  }

  private endPaste(): void {
    const { chunks, refused } = this.paste;
    const at = this.seqAt;
    this.paste = { chunks: [], size: 0, refused: false, endMatched: 0 };
    this.ground();
    this.emit({ type: "paste", text: refused ? "" : utf8.decode(Buffer.concat(chunks)), complete: !refused }, at);
  }

  /** Sets the wait a read leaves behind: the Esc wait after a lone ESC, `ESC [` or `ESC O`, the drop wait inside a longer sequence. */
  private arm(now: number): void {
    const introducerOnly = this.state === "esc" || ((this.state === "csi" || this.state === "ss3") && this.seq.length === 2);
    if (introducerOnly) this.pending = now + (this.modes.mouse || this.modes.kitty ? ESC_WAIT_SLOW_MS : ESC_WAIT_MS);
    else if (this.state === "csi" || this.state === "string") this.pending = this.seqAt + SEQUENCE_DROP_MS;
    else this.pending = undefined;
  }

  /** Ends every wait that ran out by `now`, the earlier first. */
  private expire(now: number): void {
    for (;;) {
      const pending = this.pending !== undefined && this.pending <= now ? this.pending : undefined;
      const replies = this.replyUntil !== undefined && this.replyUntil <= now ? this.replyUntil : undefined;
      if (pending !== undefined && (replies === undefined || pending <= replies)) {
        this.pending = undefined;
        this.flushSequence();
      } else if (replies !== undefined) {
        this.replyUntil = undefined;
        this.emit({ type: "reply", kind: "timeout", data: "" }, replies);
      } else return;
    }
  }

  /** A sequence its wait ended: an introducer alone is a key, anything longer is dropped. */
  private flushSequence(): void {
    const at = this.seqAt;
    if (this.state === "esc") {
      this.ground();
      this.emit(typedEscape, at);
    } else if ((this.state === "csi" || this.state === "ss3") && this.seq.length === 2) {
      const char = this.state === "csi" ? "[" : "O";
      this.ground();
      this.emit(typedKey(char, { alt: true }), at);
    } else if (this.state === "csi" || this.state === "string") {
      this.finish(undefined);
    }
  }
}

const typedEscape: Unstamped = { type: "key", key: "ESCAPE", mods: {}, action: "press" };
