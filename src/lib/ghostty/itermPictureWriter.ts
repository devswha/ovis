import { base64Length, ITERM_ARGS_ROOM, ITERM_PICTURE_COMMANDS, itermFile, itermMultipart, type PictureLimits } from "../itermPicturePayload.ts";
import { itermKitty, MAX_PICTURE_BYTES, MAX_PICTURE_PIXELS, type PictureGrid, type PicturePayload } from "./itermKitty.ts";

type Chunk = string | Uint8Array;
type Segment = Chunk | PicturePayload;

const OSC = "\x1b]1337;";
const HEADS = ITERM_PICTURE_COMMANDS.map((command) => OSC + command);
const latin1 = new TextDecoder("latin1");
const ascii = new TextEncoder();

function pictureScanner(limits: () => PictureLimits | null) {
  let state: "text" | "head" | "string" | "picture" = "text";
  let head = "";
  let byteHead = false;
  let stringEscape = false;
  let pictureEscape = false;
  let single = false;
  let parts: string[] = [];
  let recent: string[] = [];
  let size = 0;
  let limit = 0;
  const multipart = itermMultipart((args, base64) => ({ args, base64 }), () => limits() ?? { sizeLimit: 0, pixelLimit: 0 });

  function* scan(data: Chunk): Generator<Segment, void> {
    const text = typeof data === "string" ? data : latin1.decode(data);
    const slice = (start: number, end: number): Chunk => typeof data === "string" ? text.slice(start, end) : data.subarray(start, end);
    const boundary = /[\x07\x18\x1a\x1b]/g;
    let at = 0;
    let from = 0;
    // The held ESC may have come from a previous write. Keep the common case in contiguous slices.
    let escapeAt = -1;
    while (at < text.length) {
      let st = false;
      if (state === "head") {
        const ch = text.charAt(at);
        const next = head + ch;
        if (HEADS.some((prefix) => prefix.startsWith(next))) {
          head = next;
          at++;
          if (HEADS.includes(head)) {
            if (escapeAt > from) yield slice(from, escapeAt);
            state = "picture";
            single = head.endsWith(";File=");
            const caps = limits();
            limit = caps ? ITERM_ARGS_ROOM + base64Length(caps.sizeLimit) : 0;
            size = head.length - OSC.length;
            if (limit) recent.push(head.slice(OSC.length));
          }
        } else {
          state = head.length > 1 || "P_^X".includes(ch) ? "string" : "text";
          // ESC plus a string introducer is not part of that string's payload.
          if (head.length === 1 && state === "string") { head += ch; at++; }
          if (escapeAt < 0) {
            yield byteHead ? ascii.encode(head) : head;
            from = at;
          }
        }
        continue;
      }
      if (state === "picture" && pictureEscape) {
        pictureEscape = false;
        if (text.charAt(at) !== "\\") {
          if (!single) multipart.reset();
          parts = []; recent = [];
          head = "\x1b";
          from = Math.max(escapeAt, 0);
          state = "head";
          continue;
        }
        st = true;
      } else if (state === "string" && stringEscape) {
        stringEscape = false;
        if (text.charAt(at) === "\\") {
          if (escapeAt < 0) { yield byteHead ? ascii.encode("\x1b\\") : "\x1b\\"; from = at + 1; }
          at++;
        }
        else { head = "\x1b"; state = "head"; continue; }
        state = "text";
        continue;
      }

      if (state === "text") {
        const esc = text.indexOf("\x1b", at);
        if (esc < 0) { at = text.length; break; }
        head = "\x1b";
        escapeAt = esc;
        byteHead = typeof data !== "string";
        state = "head";
        at = esc + 1;
        continue;
      }

      boundary.lastIndex = at;
      const end = st ? at : boundary.exec(text)?.index ?? text.length;
      if (state === "string") {
        if (end === text.length) { at = end; break; }
        if (text.charAt(end) === "\x1b") {
          stringEscape = true;
          escapeAt = end;
          byteHead = typeof data !== "string";
        } else state = "text";
      } else {
        if (limit && end > at) {
          size += end - at;
          if (size > limit) { limit = 0; parts = []; recent = []; }
          else {
            recent.push(text.slice(at, end));
            if (recent.length >= 1024) parts.push(recent.splice(0).join(""));
          }
        }
        if (end === text.length) return;
        if (text.charAt(end) === "\x1b") {
          pictureEscape = true;
          escapeAt = end;
          byteHead = typeof data !== "string";
        } else {
          state = "text";
          from = end + 1;
          const payload = limit && limits() && (st || text.charAt(end) === "\x07") ? parts.join("") + recent.join("") : "";
          parts = []; recent = [];
          if (!payload && !single) multipart.reset();
          const picture = payload ? (single ? itermFile(payload) : multipart.handle(payload)) : null;
          if (picture) yield picture;
        }
      }
      at = end + 1;
    }
    if (state === "picture") return;
    const safeEnd = state === "head" || stringEscape ? escapeAt : at;
    if (safeEnd > from) yield slice(from, safeEnd);
  }
  return {
    scan,
    reset: () => {
      state = "text";
      stringEscape = pictureEscape = false;
      parts = []; recent = [];
      multipart.reset();
    },
  };
}

type Emit = (data: Chunk, picture?: boolean) => void;
interface Job {
  readonly input: Generator<Segment, void>;
  readonly weight: number;
  readonly emit: Emit;
  readonly done?: () => void;
}

const MAX_PENDING = 8 * 1024 * 1024;
const MAX_ACTIVE = 64 * 1024 * 1024;
const MAX_WRITES = 1024;

export function itermPictureWriter(settings: () => PictureLimits | null, grid: () => PictureGrid) {
  const limits = (): PictureLimits | null => {
    const caps = settings();
    return caps && { sizeLimit: Math.min(caps.sizeLimit, MAX_PICTURE_BYTES), pixelLimit: Math.min(caps.pixelLimit, MAX_PICTURE_PIXELS) };
  };
  const scanner = pictureScanner(limits);
  const queue: Job[] = [];
  let weight = 0;
  let draining = false;
  let pending: Promise<string> | null = null;
  let decoding = false;

  const drain = (): void => {
    if (draining) return;
    draining = true;
    try {
      while (pending === null) {
        const job = queue[0];
        if (!job) break;
        const next = job.input.next();
        if (next.done) {
          queue.shift();
          weight -= job.weight;
          job.done?.();
          continue;
        }
        const part = next.value;
        if (typeof part === "string" || part instanceof Uint8Array) { job.emit(part); continue; }
        const caps = limits();
        if (!caps) continue;
        const image = itermKitty(part, caps, grid);
        if (typeof image === "string") { if (image) job.emit(image, true); continue; }
        if (decoding || job.weight > MAX_ACTIVE || weight - job.weight > MAX_PENDING) continue;
        decoding = true;
        const conversion = image();
        pending = conversion;
        const finish = (output: string): void => {
          decoding = false;
          if (pending !== conversion) return;
          pending = null;
          if (output && limits()) job.emit(output, true);
          drain();
        };
        void conversion.then(finish, () => finish(""));
      }
    } finally { draining = false; }
  };
  return {
    write(data: Chunk, emit: Emit, done?: () => void): void {
      const size = data.length * (typeof data === "string" ? 2 : 1);
      queue.push({ input: scanner.scan(data), weight: size, emit, done });
      weight += size;
      // Skip the in-flight image on overflow, not the bytes queued behind it. Do not start
      // another browser decode until the abandoned one has finished.
      if (weight - (queue[0]?.weight ?? 0) > MAX_PENDING || queue.length > MAX_WRITES) pending = null;
      drain();
    },
    flush(): void { pending = null; drain(); },
    reset(): void {
      pending = null;
      scanner.reset();
      const discarded = queue.splice(0);
      weight = 0;
      for (const job of discarded) job.done?.();
    },
  };
}
