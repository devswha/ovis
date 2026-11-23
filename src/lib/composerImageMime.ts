const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export function composerImageMimeType(name: string, type: string): string | null {
  const normalizedType = type.toLowerCase();
  if (normalizedType !== "" && normalizedType !== "application/octet-stream") return null;

  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return null;
  return IMAGE_MIME_TYPE_BY_EXTENSION[name.slice(dotIndex + 1).toLowerCase()] ?? null;
}

export function normalizeComposerImageFile(file: File): File {
  const mimeType = composerImageMimeType(file.name, file.type);
  return mimeType === null
    ? file
    : new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
}

const HEIC_TYPES: ReadonlySet<string> = new Set(["image/heic", "image/heif"]);
const HEIC_NAME = /\.(heic|heif)$/i;
const HEIF_STILL_BRANDS: ReadonlySet<string> = new Set(["heic", "heix", "mif1", "heif"]);
const HEIF_EXCLUDED_BRANDS: ReadonlySet<string> = new Set(["msf1", "hevc", "hevx", "hevs", "avis", "avif"]);
const MAX_FTYP_INSPECT_BYTES = 4096;
/**
 * A photo is drawn at most 2048 px a side, about 1 MB as JPEG, so it uploads fast on mobile data.
 * An agent may read more: OpenAI's newest models a phone photo whole at their default, `gpt-5.5` up
 * to 6000 px and its older ones 2048 (https://developers.openai.com/api/docs/guides/images-vision),
 * Claude 2576 on its newest models and 1568 on the rest
 * (https://platform.claude.com/docs/en/build-with-claude/vision). It also keeps a 48 MP photo's
 * canvas far under iOS's 8192 by 8192 limit.
 * https://github.com/WebKit/WebKit/blob/09c9c87594bc34ed7d62db836b29091798073eb8/Source/WebCore/html/CanvasBase.cpp#L127-L128
 */
const MAX_PHOTO_SIDE = 2048;

function brandAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

/**
 * Inspects an ISO-BMFF `ftyp` header and returns true only for still HEIC/HEIF images.
 * Animated sequences (e.g. `msf1`, `hevc`, `hevs`, `avis`), AVIF containers, oversized/truncated `ftyp` boxes,
 * and non-HEIF payloads (such as a PNG renamed `.heic`) return false.
 */
export function isStillHeifContainer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16) return false;
  if (brandAt(bytes, 4) !== "ftyp") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size32 = view.getUint32(0, false);
  let headerStart = 8;
  let end: number;
  if (size32 === 1) {
    if (bytes.byteLength < 24) return false;
    const large = view.getBigUint64(8, false);
    if (large < 24n || large > BigInt(bytes.byteLength)) return false;
    end = Number(large);
    headerStart = 16;
  } else if (size32 === 0) {
    end = bytes.byteLength;
  } else {
    if (size32 < 16 || size32 > bytes.byteLength) return false;
    end = size32;
  }
  const compatStart = headerStart + 8;
  if (end < compatStart) return false;
  const brands = [brandAt(bytes, headerStart)];
  for (let offset = compatStart; offset + 4 <= end; offset += 4) brands.push(brandAt(bytes, offset));
  if (brands.some((brand) => HEIF_EXCLUDED_BRANDS.has(brand))) return false;
  return brands.some((brand) => HEIF_STILL_BRANDS.has(brand));
}

/** Decodes an image this browser can draw and encodes it as JPEG; null when the canvas refuses. */
async function canvasJpeg(image: Blob): Promise<Blob | null> {
  const url = URL.createObjectURL(image);
  try {
    const element = new Image();
    element.src = url;
    await element.decode();
    if (element.naturalWidth <= 0 || element.naturalHeight <= 0) return null;

    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(element.naturalWidth, element.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(element.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(element.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob !== null && blob.size > 0 && blob.type === "image/jpeg" ? blob : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A photo as a JPEG of at most `MAX_PHOTO_SIDE` a side: a still HEIC or HEIF one always, since the
 * agents read only PNG, JPEG, GIF and WebP
 * (https://platform.claude.com/docs/en/build-with-claude/vision), and a JPEG one too, which drops
 * its camera metadata. Any other file (a screenshot's PNG, an animated HEIC sequence, a file that is
 * not HEIF inside), or one this browser cannot decode, as it is.
 */
export async function uploadableImage<T extends Blob>(file: T, toJpeg: (image: Blob) => Promise<Blob | null> = canvasJpeg): Promise<T | File> {
  const name = file instanceof File ? file.name : "";
  const normalizedType = file.type.toLowerCase().split(";", 1)[0]!.trim();
  const heicCandidate = HEIC_TYPES.has(normalizedType)
    || ((normalizedType === "" || normalizedType === "application/octet-stream") && HEIC_NAME.test(name));
  if (!heicCandidate && normalizedType !== "image/jpeg") return file;

  if (heicCandidate) {
    const header = new Uint8Array(await file.slice(0, MAX_FTYP_INSPECT_BYTES).arrayBuffer());
    if (!isStillHeifContainer(header)) return file;
  }

  const jpeg = await toJpeg(file).catch(() => null);
  if (jpeg === null) return file;

  const base = name.replace(/\.(heic|heif|jpe?g|jpe|jfif)$/i, "") || "photo";
  return new File([jpeg], `${base}.jpg`, { type: "image/jpeg", lastModified: file instanceof File ? file.lastModified : Date.now() });
}
