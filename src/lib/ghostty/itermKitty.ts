import { decodedLength, fromBase64, sizeOf, toBase64, validBase64, type PictureLimits } from "../itermPicturePayload.ts";
import { decodeTiff, encodePng, isTiff } from "../itermPictures.ts";

export interface PictureGrid { readonly cols: number; readonly rows: number; readonly cellW: number; readonly cellH: number }

// Keep image bytes, decoded pixels and pending output bounded independently.
export const MAX_PICTURE_BYTES = 20_000_000;
export const MAX_PICTURE_PIXELS = 4096 * 4096;
const CHUNK = 4096;
const PNG_PREFIX = "iVBORw0KGgo";

interface PngSize { readonly width: number; readonly height: number }

function pngSize(bytes: Uint8Array): PngSize | null {
  if (bytes.length < 24) return null;
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a
    || header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452) return null;
  return { width: header.getUint32(16), height: header.getUint32(20) };
}

function cells(value: string | undefined, cell: number, count: number): number | null {
  if (!value || !/^\d+(?:px|%)?$/.test(value)) return null;
  const n = Number.parseInt(value, 10);
  const result = value.endsWith("px") ? Math.ceil(n / cell) : value.endsWith("%") ? Math.ceil(n * count / 100) : n;
  return result > 0 ? result : null;
}

function kittyPlacement(args: ReadonlyMap<string, string>, grid: PictureGrid, image: PngSize): { readonly keys: string; readonly pixels: number } {
  const cols = cells(args.get("width"), grid.cellW, grid.cols);
  const rows = cols && args.get("preserveAspectRatio") !== "0" ? null : cells(args.get("height"), grid.cellH, grid.rows);
  const width = cols === null ? null : cols * grid.cellW;
  const height = rows === null ? null : rows * grid.cellH;
  const drawnW = width ?? (height === null ? image.width : height * image.width / image.height);
  const drawnH = height ?? (width === null ? image.height : width * image.height / image.width);
  return {
    keys: `${cols ? `,c=${cols}` : ""}${rows ? `,r=${rows}` : ""}`,
    pixels: (cols ?? 0) > 0xffff || (rows ?? 0) > 0xffff ? Infinity : Math.ceil(drawnW) * Math.ceil(drawnH),
  };
}

export function kittyPng(base64: string, placement = ""): string {
  const chunks: string[] = [];
  for (let at = 0; at < base64.length; at += CHUNK) {
    const header = at === 0 ? `f=100,a=T,q=2${placement},` : "";
    chunks.push(`\x1b_G${header}m=${at + CHUNK < base64.length ? 1 : 0};${base64.slice(at, at + CHUNK)}\x1b\\`);
  }
  return chunks.join("");
}

async function browserPng(bytes: Uint8Array<ArrayBuffer>, limits: PictureLimits): Promise<Uint8Array | null> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    if (bitmap.width * bitmap.height >= limits.pixelLimit) return null;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const png = await canvas.convertToBlob({ type: "image/png" });
    return png.size > limits.sizeLimit ? null : new Uint8Array(await png.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

async function convertPng(bytes: Uint8Array<ArrayBuffer>, limits: PictureLimits): Promise<Uint8Array | null> {
  if (!isTiff(bytes)) return browserPng(bytes, limits);
  const tiff = decodeTiff(bytes, limits.pixelLimit);
  return tiff?.rgba ? encodePng(tiff.width, tiff.height, tiff.rgba) : null;
}

export interface PicturePayload { readonly args: string; readonly base64: string }

export function itermKitty({ args, base64 }: PicturePayload, limits: PictureLimits, grid: () => PictureGrid): string | (() => Promise<string>) {
  const fields = new Map<string, string>();
  for (const field of args.split(";")) {
    const equals = field.indexOf("=");
    if (equals >= 0) fields.set(field.slice(0, equals), field.slice(equals + 1));
  }
  if (fields.get("inline") !== "1" || (sizeOf(args) ?? 0) > limits.sizeLimit
    || decodedLength(base64) > limits.sizeLimit || !validBase64(base64)) return "";

  const place = (png: PngSize | null, payload: () => string): string => {
    if (!png || png.width === 0 || png.height === 0 || png.width * png.height >= limits.pixelLimit) return "";
    const placement = kittyPlacement(fields, grid(), png);
    return placement.pixels < limits.pixelLimit ? kittyPng(payload(), placement.keys) : "";
  };
  if (base64.startsWith(PNG_PREFIX)) return place(pngSize(fromBase64(base64.slice(0, 32))), () => base64);

  // The browser rejects corrupt or unsupported image files; drop them, not the terminal output after them.
  return async () => {
    try {
      const converted = await convertPng(fromBase64(base64), limits);
      return converted && converted.byteLength <= limits.sizeLimit ? place(pngSize(converted), () => toBase64(converted)) : "";
    } catch (error) {
      if (error instanceof Error || error instanceof DOMException) return "";
      throw error;
    }
  };
}
