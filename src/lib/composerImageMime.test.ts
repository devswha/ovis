import { describe, expect, test } from "bun:test";
import { composerImageMimeType, normalizeComposerImageFile, uploadableImage, withoutJpegMetadata } from "./composerImageMime.ts";

describe("composerImageMimeType", () => {
  test("infers supported image types for missing and generic MIME types", () => {
    const cases: readonly [string, string][] = [
      ["shot.PNG", "image/png"],
      ["photo.jpg", "image/jpeg"],
      ["photo.jpeg", "image/jpeg"],
      ["photo.jfif", "image/jpeg"],
      ["photo.JPE", "image/jpeg"],
      ["animation.gif", "image/gif"],
      ["screen.webp", "image/webp"],
    ];
    for (const [name, mime] of cases) {
      expect(composerImageMimeType(name, "")).toBe(mime);
      expect(composerImageMimeType(name, "application/octet-stream")).toBe(mime);
    }
  });

  test("leaves explicit MIME types and unknown extensions alone", () => {
    expect(composerImageMimeType("photo.png", "text/plain")).toBeNull();
    expect(composerImageMimeType("photo.heic", "")).toBeNull();
    expect(composerImageMimeType("photo", "application/octet-stream")).toBeNull();
    expect(composerImageMimeType(".png", "")).toBeNull();
  });

  test("normalizes a generic image file for the image upload path", async () => {
    const source = new File(["image bytes"], "screen.png", { type: "application/octet-stream", lastModified: 123 });
    const normalized = normalizeComposerImageFile(source);
    expect(normalized).not.toBe(source);
    expect(normalized.type).toBe("image/png");
    expect(normalized.name).toBe(source.name);
    expect(normalized.lastModified).toBe(source.lastModified);
    expect(await normalized.text()).toBe("image bytes");
    const unknown = new File(["x"], "notes.txt");
    expect(normalizeComposerImageFile(unknown)).toBe(unknown);
  });
});

const segment = (marker: number, body: readonly number[]): number[] => [0xff, marker, 0, body.length + 2, ...body];
const jfif = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0]);
const icc = segment(0xe2, [1, 2, 3]);
const scan = [...segment(0xda, [9, 9]), 0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33, 0xff, 0xd9];
const withoutMetadataBytes: number[] = [0xff, 0xd8, ...jfif, ...icc, ...scan];
const jpegBytes: Uint8Array<ArrayBuffer> = new Uint8Array([0xff, 0xd8, ...jfif, ...segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 7]), ...icc, ...segment(0xed, [8, 8]), ...scan]);

describe("withoutJpegMetadata", () => {
  test("drops APP1 and APP13, keeps every other segment and the scan byte for byte", async () => {
    const stripped = await withoutJpegMetadata(new Blob([jpegBytes], { type: "image/jpeg" }));
    expect([...new Uint8Array(await stripped.arrayBuffer())]).toEqual(withoutMetadataBytes);
  });

  test("keeps only the Exif orientation, so a portrait stored sideways still stands up", async () => {
    const tiff = (entries: readonly number[][]): number[] => [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, entries.length, ...entries.flat(), 0, 0, 0, 0];
    const exif = (entries: readonly number[][]): number[] => segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff(entries)]);
    const orientation = [0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0];
    const make = [0x01, 0x0f, 0, 2, 0, 0, 0, 4, 0x41, 0x70, 0x70, 0];
    const portrait = new Blob([new Uint8Array([0xff, 0xd8, ...jfif, ...exif([orientation, make]), ...icc, ...scan])], { type: "image/jpeg" });
    const stripped = await withoutJpegMetadata(portrait);
    expect([...new Uint8Array(await stripped.arrayBuffer())]).toEqual([0xff, 0xd8, ...jfif, ...exif([orientation]), ...icc, ...scan]);

    const littleEndian = segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
    const android = await withoutJpegMetadata(new Blob([new Uint8Array([0xff, 0xd8, ...littleEndian, ...scan])], { type: "image/jpeg" }));
    expect([...new Uint8Array(await android.arrayBuffer())]).toEqual([0xff, 0xd8, ...exif([orientation]), ...scan]);
  });

  test("reads past fill bytes before a marker, so they cannot hide the Exif", async () => {
    const filled = new Uint8Array([0xff, 0xd8, 0xff, ...jfif, 0xff, 0xff, ...segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 7]), ...icc, 0xff, ...scan]);
    const stripped = await withoutJpegMetadata(new Blob([filled], { type: "image/jpeg" }));
    expect([...new Uint8Array(await stripped.arrayBuffer())]).toEqual(withoutMetadataBytes);
  });

  test("ends at the first image, dropping a second frame's Exif and the MPF index that points at it", async () => {
    const mpf = segment(0xe2, [0x4d, 0x50, 0x46, 0, 1, 2]);
    const second = [0xff, 0xd8, ...segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 7]), ...scan];
    const multi = new Uint8Array([0xff, 0xd8, ...jfif, ...mpf, ...icc, ...scan, ...second]);
    const stripped = await withoutJpegMetadata(new Blob([multi], { type: "image/jpeg" }));
    expect([...new Uint8Array(await stripped.arrayBuffer())]).toEqual(withoutMetadataBytes);
  });

  test("reads the scan past fill bytes before a restart marker, so the first image still ends at its EOI", async () => {
    const filledScan = [...segment(0xda, [9, 9]), 0x11, 0xff, 0xff, 0xd0, 0x22, 0xff, 0xff, 0x00, 0x33, 0xff, 0xd9];
    const second = [0xff, 0xd8, ...segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 7]), ...scan];
    const stripped = await withoutJpegMetadata(new Blob([new Uint8Array([0xff, 0xd8, ...jfif, ...filledScan, ...second])], { type: "image/jpeg" }));
    expect([...new Uint8Array(await stripped.arrayBuffer())]).toEqual([0xff, 0xd8, ...jfif, ...filledScan]);
  });

  test("skips stray bytes between segments, as a decoder does, so they cannot hide the Exif after them", async () => {
    const stray = new Uint8Array([0xff, 0xd8, 0x00, ...jfif, 0x12, 0x34, ...segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 7]), ...icc, ...scan]);
    const stripped = await withoutJpegMetadata(new Blob([stray], { type: "image/jpeg" }));
    expect([...new Uint8Array(await stripped.arrayBuffer())]).toEqual(withoutMetadataBytes);

    const cut = await withoutJpegMetadata(new Blob([new Uint8Array([0xff, 0xd8, ...jfif, 0xff, 0xe1, 0])], { type: "image/jpeg" }));
    expect([...new Uint8Array(await cut.arrayBuffer())]).toEqual([0xff, 0xd8, ...jfif]);
  });

  test("drops an Exif whose IFD lies outside its segment or whose entry count ends before the orientation", async () => {
    const outside = segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0x10, 0, 0, 0]);
    const counted = segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 0, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
    for (const exif of [outside, counted]) {
      const stripped = await withoutJpegMetadata(new Blob([new Uint8Array([0xff, 0xd8, ...exif, ...scan])], { type: "image/jpeg" }));
      expect([...new Uint8Array(await stripped.arrayBuffer())]).toEqual([0xff, 0xd8, ...scan]);
    }
  });

  test("leaves bytes that do not open as a JPEG alone", async () => {
    const other = new Blob(["not a jpeg"], { type: "image/jpeg" });
    expect(await withoutJpegMetadata(other)).toBe(other);
  });
});

describe("uploadableImage", () => {
  const jpeg = async (): Promise<Blob> => new Blob(["jpeg bytes"], { type: "image/jpeg" });
  const ftyp = (major: string, compat: readonly string[] = []): Uint8Array<ArrayBuffer> => {
    const size = 16 + compat.length * 4;
    const bytes = new Uint8Array(new ArrayBuffer(size));
    new DataView(bytes.buffer).setUint32(0, size, false);
    const write = (offset: number, fourcc: string) => {
      for (let i = 0; i < 4; i++) bytes[offset + i] = fourcc.charCodeAt(i);
    };
    write(4, "ftyp");
    write(8, major);
    compat.forEach((brand, index) => write(16 + index * 4, brand));
    return bytes;
  };
  const STILL_HEIC = ftyp("heic", ["mif1", "heic"]);
  const STILL_HEIF = ftyp("mif1", ["mif1", "heif"]);
  const ANIMATED_HEIC = ftyp("msf1", ["msf1", "heic", "hevc"]);
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

  test("hands an agent a JPEG for an iPhone's HEIC or HEIF photo", async () => {
    const cases: readonly File[] = [
      new File([STILL_HEIC], "IMG_0001.HEIC", { type: "image/heic", lastModified: 7 }),
      new File([STILL_HEIC], "IMG_0002.heic", { type: "" }),
      new File([STILL_HEIC], "IMG_0003.HEIC", { type: "application/octet-stream" }),
      new File([STILL_HEIF], "photo.heif", { type: "image/heif" }),
      new File([STILL_HEIC], ".heic", { type: "image/heic" }),
    ];
    const converted = await Promise.all(cases.map((file) => uploadableImage(file, jpeg)));
    expect(converted.map((file) => [file.name, file.type])).toEqual([
      ["IMG_0001.jpg", "image/jpeg"], ["IMG_0002.jpg", "image/jpeg"], ["IMG_0003.jpg", "image/jpeg"], ["photo.jpg", "image/jpeg"], ["photo.jpg", "image/jpeg"],
    ]);
    expect(converted[0]!.lastModified).toBe(7);
    expect(await converted[0]!.text()).toBe("jpeg bytes");
  });

  test("preserves animated HEIC/HEIF sequences, AVIF containers, and oversized ftyp boxes without collapsing frames, and handles 64-bit ftyp sizes", async () => {
    const ftypWithBrands = (major: string, compat: string[]): Uint8Array<ArrayBuffer> => {
      const size = 16 + compat.length * 4;
      const buf = new Uint8Array(size);
      new DataView(buf.buffer).setUint32(0, size, false);
      buf.set(new TextEncoder().encode(`ftyp${major}`), 4);
      compat.forEach((b, i) => buf.set(new TextEncoder().encode(b), 16 + i * 4));
      return buf;
    };
    const lateSequence = ftypWithBrands("heic", [
      "mif1", "heic", "pad1", "pad2", "pad3", "pad4", "pad5", "pad6",
      "pad7", "pad8", "pad9", "pa10", "avis", "msf1",
    ]);
    const avifStill = ftypWithBrands("avif", ["avif", "mif1", "miaf"]);
    const sequences = [
      new File([ANIMATED_HEIC], "sticker.heics", { type: "image/heic-sequence" }),
      new File([ANIMATED_HEIC], "animated.heic", { type: "image/heic-sequence" }),
      new File([ANIMATED_HEIC], "burst.heif", { type: "image/heif-sequence" }),
      new File([ANIMATED_HEIC], "sticker.heics", { type: "image/heic" }),
      new File([ANIMATED_HEIC], "sticker.heic", { type: "" }),
      new File([lateSequence], "late-seq.heif", { type: "" }),
      new File([avifStill], "white.heif", { type: "" }),
    ];
    const decoded: Blob[] = [];
    for (const file of sequences) {
      expect(await uploadableImage(file, async (blob) => { decoded.push(blob); return jpeg(); })).toBe(file);
    }
    expect(decoded).toEqual([]);

    // 64-bit largesize ftyp box (size32 === 1) for a still HEIC photo converts normally.
    const largeFtyp = new Uint8Array(32);
    const view = new DataView(largeFtyp.buffer);
    view.setUint32(0, 1, false);
    largeFtyp.set(new TextEncoder().encode("ftyp"), 4);
    view.setBigUint64(8, 32n, false);
    largeFtyp.set(new TextEncoder().encode("heic"), 16);
    largeFtyp.set(new TextEncoder().encode("mif1"), 24);
    const largePhoto = new File([largeFtyp], "large.heic", { type: "image/heic" });
    const converted = await uploadableImage(largePhoto, async () => jpeg());
    expect(converted.type).toBe("image/jpeg");
  });

  test("sends a HEIC photo as it is when this browser cannot decode it", async () => {
    const photo = new File([STILL_HEIC], "IMG_0001.HEIC", { type: "image/heic" });
    expect(await uploadableImage(photo, async () => null)).toBe(photo);
    expect(await uploadableImage(photo, async () => { throw new Error("EncodingError"); })).toBe(photo);
  });

  test("sends every JPEG photo redrawn, which drops its camera metadata, even when that is no smaller", async () => {
    const photo = new File(["x".repeat(4096)], "IMG_3718.jpeg", { type: "image/jpeg", lastModified: 7 });
    const smaller = await uploadableImage(photo, jpeg);
    expect([smaller.name, smaller.type, smaller.lastModified, await smaller.text()]).toEqual(["IMG_3718.jpg", "image/jpeg", 7, "jpeg bytes"]);

    const small = new File(["tiny"], "IMG_3719.jpg", { type: "image/jpeg" });
    expect(await (await uploadableImage(small, jpeg)).text()).toBe("jpeg bytes");

    const names = await Promise.all(["photo.jfif", "photo.JPE", "photo.JPG"].map(async (name) => (await uploadableImage(new File(["x"], name, { type: "image/jpeg" }), jpeg)).name));
    expect(names).toEqual(["photo.jpg", "photo.jpg", "photo.jpg"]);
  });

  test("redraws a JPEG whose type the browser left empty, as a terminal attachment brings it", async () => {
    const cases = [new File(["x"], "IMG_3721.JPG", { type: "" }), new File(["x"], "IMG_3722.jpeg", { type: "application/octet-stream" })];
    const sent = await Promise.all(cases.map((file) => uploadableImage(file, jpeg)));
    expect(await Promise.all(sent.map(async (file) => [file.name, file.type, await file.text()]))).toEqual([
      ["IMG_3721.jpg", "image/jpeg", "jpeg bytes"], ["IMG_3722.jpg", "image/jpeg", "jpeg bytes"],
    ]);

    const undrawable = await uploadableImage(new File([jpegBytes], "IMG_3723.jpg", { type: "" }), async () => null);
    expect([undrawable.type, [...new Uint8Array(await undrawable.arrayBuffer())]]).toEqual(["image/jpeg", withoutMetadataBytes]);
  });

  test("cuts the location, device and date out of a JPEG this browser cannot redraw", async () => {
    const photo = new File([jpegBytes], "IMG_3720.jpg", { type: "image/jpeg", lastModified: 7 });
    const sent = await uploadableImage(photo, async () => null);
    expect([sent.name, sent.type, sent.lastModified]).toEqual(["IMG_3720.jpg", "image/jpeg", 7]);
    expect([...new Uint8Array(await sent.arrayBuffer())]).toEqual(withoutMetadataBytes);
  });

  test("leaves non-HEIF payloads and other files alone without decoding them", async () => {
    const others = [
      new File([PNG_BYTES], "shot.png", { type: "image/png" }),
      new File([PNG_BYTES], "renamed.heic", { type: "image/png" }),
      new File([PNG_BYTES], "renamed.heic", { type: "application/octet-stream" }),
      new File([PNG_BYTES], "renamed.heic", { type: "" }),
      new File(["log"], "notes.heic.txt", { type: "text/plain" }),
    ];
    const decoded: Blob[] = [];
    for (const file of others) expect(await uploadableImage(file, async (blob) => { decoded.push(blob); return jpeg(); })).toBe(file);
    expect(decoded).toEqual([]);
  });
});
