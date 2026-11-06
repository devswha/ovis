import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { decodeTiff, itermPictures } from "./itermPictures.ts";

const LIMITS = { sizeLimit: 20_000_000, pixelLimit: 4096 * 4096 };

/** the handler with a feed that keeps what it is given, as the addon's decoder would take it */
function handler(limits = LIMITS) {
  const fed: string[] = [];
  const pictures = itermPictures((payload) => { fed.push(payload); return true; }, () => limits);
  return { fed, handle: pictures.handle, reset: pictures.reset };
}

/** an uncompressed RGBA TIFF laid out as chafa writes it for `chafa -f iterm`: pixels first, then the directory */
function chafaTiff(width: number, height: number, rgba: Uint8Array, compression = 1): Uint8Array {
  const tags: Array<[number, number, number, number]> = [
    [256, 4, 1, width], [257, 4, 1, height], [258, 3, 4, 8 + rgba.length + 2 + 12 * 12 + 4], [259, 3, 1, compression],
    [262, 3, 1, 2], [273, 4, 1, 8], [274, 3, 1, 1], [277, 3, 1, 4], [278, 4, 1, height],
    [279, 4, 1, rgba.length], [284, 3, 1, 1], [338, 3, 1, 2],
  ];
  const out = new Uint8Array(8 + rgba.length + 2 + tags.length * 12 + 4 + 8);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 0x2a, 0]);
  view.setUint32(4, 8 + rgba.length, true);
  out.set(rgba, 8);
  let at = 8 + rgba.length;
  view.setUint16(at, tags.length, true);
  at += 2;
  for (const [tag, type, count, value] of tags) {
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
    at += 12;
  }
  at += 4;
  for (let i = 0; i < 4; i++) view.setUint16(at + 2 * i, 8, true);
  return out;
}

/** a PNG's size and RGBA pixels, read back with zlib (filter 0 rows, as the encoder writes them) */
function readPng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const idatLength = view.getUint32(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 4 + 1)]).toBe(0);
    rgba.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, rgba };
}

const fedPicture = (payload: string) => {
  const match = /^File=(.*):([A-Za-z0-9+/=]*)$/.exec(payload)!;
  const bytes = Buffer.from(match[2]!, "base64");
  return { args: match[1]!, bytes: new Uint8Array(bytes) };
};

const PIXELS = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 10, 20, 30, 0, 1, 2, 3, 4, 200, 100, 50, 255]);

test("joins imgcat's multipart picture into one the addon reads, with its arguments", () => {
  const { fed, handle } = handler();
  const png = Buffer.from("\x89PNG\r\n\x1a\n-not-really-a-png-but-long-enough", "latin1").toString("base64");
  expect(handle(`MultipartFile=inline=1;size=${Buffer.from(png, "base64").length};name=cmdiLnBuZw==`)).toBe(true);
  for (let i = 0; i < png.length; i += 8) expect(handle(`FilePart=${png.slice(i, i + 8)}`)).toBe(true);
  expect(fed).toEqual([]);
  expect(handle("FileEnd")).toBe(true);
  expect(fed).toEqual([`File=inline=1;size=${Buffer.from(png, "base64").length};name=cmdiLnBuZw==:${png}`]);
  expect(handle("FileEnd")).toBe(true);
  expect(fed.length).toBe(1);
});

test("leaves a PNG with its size to the addon, and anything that is no picture", () => {
  const { fed, handle } = handler();
  const png = Buffer.from("\x89PNG\r\n\x1a\nxxxxxxxxxxxxxxxxxxxxxxxx", "latin1").toString("base64");
  expect(handle(`File=inline=1;size=32:${png}`)).toBe(false);
  expect(handle("SetMark")).toBe(false);
  expect(handle("CurrentDir=/tmp")).toBe(false);
  expect(fed).toEqual([]);
});

test("turns chafa's TIFF, sent without a size, into a PNG of the same pixels", () => {
  const { fed, handle } = handler();
  const tiff = chafaTiff(3, 2, PIXELS);
  expect(handle(`File=inline=1;width=24;height=6;preserveAspectRatio=0:${Buffer.from(tiff).toString("base64")}`)).toBe(true);
  expect(fed.length).toBe(1);
  const { args, bytes } = fedPicture(fed[0]!);
  expect(args).toBe(`inline=1;width=24;height=6;preserveAspectRatio=0;size=${bytes.length}`);
  expect(readPng(bytes)).toEqual({ width: 3, height: 2, rgba: PIXELS });
});

test("gives a TIFF it cannot decode a placeholder in its proportions instead of nothing", () => {
  const { fed, handle } = handler();
  const tiff = chafaTiff(3, 2, PIXELS, 5);
  expect(decodeTiff(tiff, LIMITS.pixelLimit)).toEqual({ width: 3, height: 2, rgba: null });
  expect(handle(`File=inline=1;size=${tiff.length}:${Buffer.from(tiff).toString("base64")}`)).toBe(true);
  const { args, bytes } = fedPicture(fed[0]!);
  expect(args).toBe(`inline=1;size=${bytes.length}`);
  const placeholder = readPng(bytes);
  expect([placeholder.width, placeholder.height]).toEqual([3, 2]);
  expect([...placeholder.rgba.subarray(0, 4)]).toEqual([0x60, 0x60, 0x60, 255]);
});

test("drops a picture past the addon's size cap, multipart ones before all of it is held", () => {
  const { fed, handle, reset } = handler({ sizeLimit: 30, pixelLimit: LIMITS.pixelLimit });
  expect(handle("MultipartFile=inline=1;size=31")).toBe(true);
  expect(handle("FilePart=AAAA")).toBe(true);
  expect(handle("FileEnd")).toBe(true);
  expect(handle("MultipartFile=inline=1")).toBe(true);
  for (let i = 0; i < 11; i++) expect(handle("FilePart=AAAA")).toBe(true);
  expect(handle("FileEnd")).toBe(true);
  expect(handle(`File=inline=1:${"A".repeat(44)}`)).toBe(true);
  expect(handle("MultipartFile=inline=1")).toBe(true);
  expect(handle("FilePart=AAAA")).toBe(true);
  reset();
  expect(handle("FileEnd")).toBe(true);
  expect(fed).toEqual([]);
});

test("does not decode a TIFF larger than the pixel cap", () => {
  const tiff = chafaTiff(3, 2, PIXELS);
  expect(decodeTiff(tiff, 6)).toEqual({ width: 3, height: 2, rgba: null });
  expect(decodeTiff(tiff, 7)?.rgba).toEqual(PIXELS);
});
