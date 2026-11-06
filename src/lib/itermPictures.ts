/**
 * iTerm2 inline pictures that xterm's image addon (0.9.0) does not take on its own, put into a form it
 * does before it sees them (lib/terminalImages.ts):
 *
 * - the multipart form iTerm2's own `imgcat` sends: `MultipartFile=<args>`, then `FilePart=<base64>`
 *   pieces, then `FileEnd`, joined into one `File=<args>:<base64>`;
 * - a picture without `size=` (`chafa -f iterm`), which the addon drops: the size is taken from the data;
 * - a TIFF picture (`chafa -f iterm` sends uncompressed RGBA TIFF), which a browser cannot decode: the
 *   baseline uncompressed 8-bit kind is turned into a PNG, any other kind into a hatched placeholder of
 *   its size, so the picture is not lost without a trace and the text after it lands where it would.
 *
 * Every other picture goes to the addon as it came. The addon's own caps still apply to what it is given.
 */

/** the addon's caps a picture is held to here too: decoded file bytes, and pixels */
export interface PictureLimits { sizeLimit: number; pixelLimit: number }

/** hands a whole `File=<args>:<base64>` payload to the addon's iTerm2 decoder */
export type PictureFeed = (payload: string) => boolean | Promise<boolean>;

const decodedLength = (base64: string): number => {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(base64.length / 4) * 3 - padding);
};

/** the base64 text that decodes to at most `bytes` bytes */
const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;

const sizeOf = (args: string): number | null => {
  const match = /(?:^|;)size=(\d+)/.exec(args);
  return match ? Number(match[1]) : null;
};

const withSize = (args: string, size: number): string =>
  sizeOf(args) === null ? `${args};size=${size}` : args.replace(/(^|;)size=\d+/, `$1size=${size}`);

const fromBase64 = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

function toBase64(bytes: Uint8Array): string {
  let out = "";
  // btoa takes a string of bytes; one call per slice keeps the argument list of fromCharCode short
  for (let i = 0; i < bytes.length; i += 0x8000) out += btoa(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return out;
}

/** the first bytes of a picture's data, enough to tell its format; none where they are no base64 */
function headOf(base64: string): Uint8Array {
  try { return fromBase64(base64.slice(0, 8).replace(/=+$/, "")); } catch { return new Uint8Array(); }
}

const isTiff = (head: Uint8Array): boolean =>
  head.length >= 4 && ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0)
    || (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a));

/** a TIFF's size, and its pixels as RGBA when it is a kind decoded here (else null) */
export interface DecodedTiff { width: number; height: number; rgba: Uint8Array | null }

/**
 * Decodes a baseline TIFF's first image when it is uncompressed, 8 bits a sample, chunky, grey (with
 * or without alpha) or RGB (with or without alpha): what chafa writes. Null when it is no TIFF or its
 * directory cannot be read; `rgba` null when it is a TIFF of another kind, or larger than `pixelLimit`.
 */
export function decodeTiff(bytes: Uint8Array, pixelLimit: number): DecodedTiff | null {
  if (!isTiff(bytes) || bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[0] === 0x49;
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  const ifd = u32(4);
  if (ifd + 2 > bytes.length) return null;
  const count = u16(ifd);
  if (ifd + 2 + count * 12 > bytes.length) return null;
  const tags = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    const type = u16(entry + 2);
    const n = u32(entry + 4);
    // BYTE, SHORT and LONG are all a baseline image needs; other types are skipped
    const width = type === 1 ? 1 : type === 3 ? 2 : type === 4 ? 4 : 0;
    if (width === 0 || n > 4096) continue;
    const at = width * n <= 4 ? entry + 8 : u32(entry + 8);
    if (at + width * n > bytes.length) return null;
    tags.set(u16(entry), Array.from({ length: n }, (_, k) => (width === 1 ? bytes[at + k]! : width === 2 ? u16(at + 2 * k) : u32(at + 4 * k))));
  }
  const one = (tag: number, fallback: number) => tags.get(tag)?.[0] ?? fallback;
  const width = one(256, 0);
  const height = one(257, 0);
  if (width === 0 || height === 0) return null;
  const decoded = { width, height, rgba: null };
  const samples = one(277, 1);
  const photometric = one(262, -1);
  const bits = tags.get(258) ?? [1];
  const offsets = tags.get(273) ?? [];
  const counts = tags.get(279) ?? [];
  const grey = photometric === 0 || photometric === 1;
  if (one(259, 1) !== 1 || one(284, 1) !== 1 || bits.some((b) => b !== 8) || offsets.length === 0
    || offsets.length !== counts.length || !(grey ? samples === 1 || samples === 2 : photometric === 2 && (samples === 3 || samples === 4))
    || width * height >= pixelLimit) return decoded;
  // gather the strips into one run of samples, row after row
  const total = width * height * samples;
  const pixels = new Uint8Array(total);
  let filled = 0;
  for (let i = 0; i < offsets.length && filled < total; i++) {
    const take = Math.min(counts[i]!, total - filled);
    if (offsets[i]! + take > bytes.length) return decoded;
    pixels.set(bytes.subarray(offsets[i]!, offsets[i]! + take), filled);
    filled += take;
  }
  if (filled < total) return decoded;
  const premultiplied = one(338, 0) === 1;
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0, s = 0; p < rgba.length; p += 4, s += samples) {
    if (grey) {
      const v = photometric === 0 ? 255 - pixels[s]! : pixels[s]!;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
    } else {
      rgba[p] = pixels[s]!;
      rgba[p + 1] = pixels[s + 1]!;
      rgba[p + 2] = pixels[s + 2]!;
    }
    const alpha = samples === 2 || samples === 4 ? pixels[s + samples - 1]! : 255;
    rgba[p + 3] = alpha;
    if (premultiplied && alpha < 255) {
      for (let c = 0; c < 3; c++) rgba[p + c] = alpha === 0 ? 0 : Math.min(255, Math.round((rgba[p + c]! * 255) / alpha));
    }
  }
  return { width, height, rgba };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * RGBA pixels as a PNG the addon decodes in the browser. The data is stored, not compressed: it is made
 * here, read once by the browser and let go, and stays about as large as the TIFF it came from.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const row = width * 4;
  const raw = new Uint8Array((row + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
  // zlib: a header, stored blocks of at most 65535 bytes, the Adler-32 of the data
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const zlib = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  const z = new DataView(zlib.buffer);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  let at = 2;
  for (let b = 0; b < blocks; b++) {
    const chunk = raw.subarray(b * 65535, Math.min(raw.length, (b + 1) * 65535));
    zlib[at] = b === blocks - 1 ? 1 : 0;
    z.setUint16(at + 1, chunk.length, true);
    z.setUint16(at + 3, chunk.length ^ 0xffff, true);
    zlib.set(chunk, at + 5);
    at += 5 + chunk.length;
  }
  let a = 1;
  let s = 0;
  for (const byte of raw) { a = (a + byte) % 65521; s = (s + a) % 65521; }
  z.setUint32(at, ((s << 16) | a) >>> 0);
  const ihdr = new Uint8Array(13);
  const h = new DataView(ihdr.buffer);
  h.setUint32(0, width);
  h.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const chunks = [["IHDR", ihdr], ["IDAT", zlib], ["IEND", new Uint8Array()]] as const;
  const png = new Uint8Array(8 + chunks.reduce((sum, [, data]) => sum + 12 + data.length, 0));
  const out = new DataView(png.buffer);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  at = 8;
  for (const [type, data] of chunks) {
    out.setUint32(at, data.length);
    const body = new Uint8Array(4 + data.length);
    for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
    body.set(data, 4);
    png.set(body, at + 4);
    out.setUint32(at + 4 + body.length, crc32(body));
    at += 12 + data.length;
  }
  return png;
}

/** the side of the most pixels a placeholder holds: the addon scales it to the picture's place anyway */
const PLACEHOLDER_SIDE = 256;

/** a grey box with darker diagonal stripes, in the picture's proportions, where a picture could not be decoded */
export function placeholderPng(width: number, height: number): Uint8Array {
  const scale = Math.min(1, PLACEHOLDER_SIDE / Math.max(width, height, 1));
  const w = Math.max(1, Math.round(width * scale) || PLACEHOLDER_SIDE);
  const h = Math.max(1, Math.round(height * scale) || PLACEHOLDER_SIDE / 4);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (x + y) % 12 < 4 ? 0x60 : 0x90;
      rgba.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return encodePng(w, h, rgba);
}

/** what the picture's data comes to once it is in a form the addon takes */
function readable(base64: string, pixelLimit: number): string {
  if (!isTiff(headOf(base64))) return base64;
  const tiff = decodeTiff(fromBase64(base64), pixelLimit);
  if (tiff?.rgba) return toBase64(encodePng(tiff.width, tiff.height, tiff.rgba));
  return toBase64(placeholderPng(tiff?.width ?? 0, tiff?.height ?? 0));
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * An OSC 1337 handler, registered after the addon so it reads each payload first: true where it took
 * the payload (a multipart piece, or a picture it handed on in a form the addon takes), false where the
 * addon reads it as it came. `reset` drops a multipart picture still coming in.
 */
export function itermPictures(feed: PictureFeed, limits: () => PictureLimits): { handle(data: string): boolean | Promise<boolean>; reset(): void } {
  let multipart: { args: string; parts: string[]; length: number } | null = null;

  const picture = (args: string, base64: string): boolean | Promise<boolean> => {
    if (!BASE64.test(base64) || base64.length === 0) return true;
    const data = readable(base64, limits().pixelLimit);
    return feed(`File=${withSize(args, decodedLength(data))}:${data}`);
  };

  return {
    reset: () => { multipart = null; },
    handle: (data) => {
      if (data.startsWith("MultipartFile=")) {
        const args = data.slice("MultipartFile=".length);
        const size = sizeOf(args);
        multipart = size !== null && size > limits().sizeLimit ? null : { args, parts: [], length: 0 };
        return true;
      }
      if (data.startsWith("FilePart=")) {
        if (multipart) {
          const part = data.slice("FilePart=".length);
          multipart.length += part.length;
          // past the addon's cap the picture is dropped now, not once all of it is held
          if (multipart.length > base64Length(limits().sizeLimit)) multipart = null;
          else multipart.parts.push(part);
        }
        return true;
      }
      if (data.startsWith("FileEnd")) {
        const done = multipart;
        multipart = null;
        return done ? picture(done.args, done.parts.join("")) : true;
      }
      if (data.startsWith("File=")) {
        const colon = data.indexOf(":");
        if (colon < 0) return false;
        const args = data.slice("File=".length, colon);
        const base64 = data.slice(colon + 1);
        // a picture the addon reads as it is goes to it untouched
        if (sizeOf(args) !== null && !isTiff(headOf(base64))) return false;
        if (base64.length > base64Length(limits().sizeLimit)) return true;
        return picture(args, base64);
      }
      return false;
    },
  };
}
