import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetTranscriptState, transcriptImage, transcriptImageAsync, transcriptPage } from "./conversation.ts";

const roots: string[] = [];
afterEach(() => {
  forgetTranscriptState();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const picture = { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } };
const line = (entry: unknown) => JSON.stringify(entry) + "\n";
function fixture(tiny = false) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-claude-image-"));
  roots.push(dir);
  const path = join(dir, "session.jsonl");
  const call = line({ type: "assistant", uuid: id(2), parentUuid: id(1), message: { content: [{ type: "tool_use", id: "read", name: "Read" }] } });
  const result = line({ type: "user", uuid: id(3), parentUuid: id(2), message: { content: [{ type: "tool_result", tool_use_id: "read", content: [picture, picture] }] } });
  const padding = tiny
    ? line({ type: "progress", data: "read", uuid: id(3) }).repeat(6000)
    : line({ type: "progress", data: "x".repeat(1024 * 1024) }).repeat(20);
  writeFileSync(path, line({ type: "user", uuid: id(1), parentUuid: null, message: { content: "read" } }) + call + padding + result);
  return { path, ref: `${id(3)}:0:0` };
}
function exact(image: Awaited<ReturnType<typeof transcriptImageAsync>>) {
  expect(image?.mediaType).toBe("image/png");
  expect(Buffer.from(image!.bytes).equals(png)).toBe(true);
  expect(image!.bytes.byteLength).toBe(png.length);
}

describe("cooperative Claude images", () => {
  for (const tiny of [false, true]) it(`runs timers and file IO before cold and warm lookups finish (${tiny ? "tiny records" : "large history"})`, async () => {
    const { path, ref } = fixture(tiny);
    for (let pass = 0; pass < 2; pass += 1) {
      let finished = false;
      const progress = new Promise<void>((resolve, reject) => setTimeout(() => {
        if (finished) { reject(new Error("image lookup blocked the timer")); return; }
        Bun.file(path).slice(0, 16).arrayBuffer().then(() => {
          try { expect(finished).toBe(false); resolve(); } catch (error) { reject(error); }
        }, reject);
      }, 0));
      const reading = Promise.all([transcriptImageAsync(path, ref), transcriptImageAsync(path, `${id(3)}:0:1`)]).then((images) => { finished = true; return images; });
      const [images] = await Promise.all([reading, progress]);
      images.forEach(exact);
    }
  });

  it("serves exactly 8 MiB and rejects an image one byte larger", async () => {
    const { path } = fixture(true);
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    png.copy(bytes);
    const image = (data: Buffer) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: data.toString("base64") } });
    writeFileSync(path, line({ type: "user", uuid: id(3), message: { content: [image(bytes), image(Buffer.concat([bytes, Buffer.from([0])]))] } }));
    const accepted = await transcriptImageAsync(path, `${id(3)}:0`);
    expect(accepted?.mediaType).toBe("image/png");
    expect(Buffer.from(accepted!.bytes).equals(bytes)).toBe(true);
    expect(await transcriptImageAsync(path, `${id(3)}:1`)).toBeNull();
  });

  it("bounds record judgments between event-loop turns even with a warm boundary", async () => {
    const { path, ref } = fixture(true);
    exact(await transcriptImageAsync(path, ref));
    let since = 0, most = 0, total = 0;
    const alloc = Buffer.alloc.bind(Buffer);
    const counting = spyOn(Buffer, "alloc").mockImplementation(((...args: Parameters<typeof Buffer.alloc>) => {
      since += 1; total += 1;
      return alloc(...args);
    }) as typeof Buffer.alloc);
    let looking = true;
    const turn = () => { most = Math.max(most, since); since = 0; if (looking) setImmediate(turn); };
    try {
      setImmediate(turn);
      exact(await transcriptImageAsync(path, ref));
    } finally { looking = false; most = Math.max(most, since); counting.mockRestore(); }
    expect(total).toBeGreaterThan(6000);
    expect(most).toBeLessThanOrEqual(100);
  });

  it("yields while constructing a search for a long decoded tool call id", async () => {
    const { path, ref } = fixture(true);
    const call = "c".repeat(100_000);
    writeFileSync(path, line({ type: "assistant", message: { content: [{ type: "tool_use", id: call, name: "Read" }] } }) + line({ type: "user", uuid: id(3), message: { content: [{ type: "tool_result", tool_use_id: call, content: [picture] }] } }));
    let finished = false;
    const progress = new Promise<void>((resolve, reject) => setTimeout(() => {
      try { expect(finished).toBe(false); resolve(); } catch (error) { reject(error); }
    }, 0));
    // Some engines refuse a regexp this large; either outcome must let other work run first.
    const reading = transcriptImageAsync(path, ref).then(() => { finished = true; });
    await Promise.all([reading, progress]);
  });

  it("rejects a second mutation after validation has already hashed the changed prefix", async () => {
    const { path, ref } = fixture();
    const original = await Bun.file(path).bytes();
    let starts = 0;
    let changed = false;
    const read = fs.readSync;
    const watching = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const result = read(...args);
      const request = args as unknown as [number, Uint8Array, number, number, number];
      // Prefix fingerprint, uuid search, call search, then the validation fingerprint.
      if (request[4] === 0 && request[3] === 1024 * 1024 && ++starts === 4) setImmediate(() => {
        const bytes = Buffer.from(original);
        bytes.write("gone", bytes.indexOf('"id":"read"') + 6);
        writeFileSync(path, bytes);
        appendFileSync(path, line({ type: "progress", data: "second append" }));
        changed = true;
      });
      return result;
    }) as typeof fs.readSync);
    try {
      const reading = transcriptImageAsync(path, ref);
      await new Promise<void>((resolve) => setImmediate(resolve));
      appendFileSync(path, line({ type: "progress", data: "first append" }));
      expect(await reading).toBeNull();
      expect(changed).toBe(true);
    } finally { watching.mockRestore(); }
  });

  for (const change of ["replace", "truncate", "rewrite", "rewrite and grow", "clear", "rewind"] as const) it(`rejects an image after an in-flight ${change}`, async () => {
    const { path, ref } = fixture();
    const reading = transcriptImageAsync(path, ref);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (change === "replace") { writeFileSync(`${path}.new`, line({ type: "user", uuid: id(3), message: { content: [picture] } })); renameSync(`${path}.new`, path); }
    if (change === "truncate") truncateSync(path, 0);
    if (change === "rewrite" || change === "rewrite and grow") {
      const bytes = await Bun.file(path).bytes();
      // Keep the tail and inode: a prefix rewrite must not pass an append-only check.
      bytes[Buffer.from(bytes).indexOf('"read"') + 1] = 120;
      writeFileSync(path, bytes);
      if (change === "rewrite and grow") appendFileSync(path, line({ type: "progress", data: "appended" }));
    }
    if (change === "clear") appendFileSync(path, line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }));
    if (change === "rewind") appendFileSync(path, line({ type: "user", uuid: id(4), parentUuid: null, message: { content: "new branch" } }));
    expect(await reading).toBeNull();
    // A failed old read cannot leave a half-built or obsolete shared boundary behind.
    if (change === "rewrite" || change === "rewrite and grow") {
      exact(await transcriptImageAsync(path, ref));
      exact(transcriptImage(path, ref));
    } else {
      expect(await transcriptImageAsync(path, ref)).toBeNull();
      expect(transcriptImage(path, ref)).toBeNull();
    }
  });

  it("allows a harmless append and concurrent page/image reads without downgrading the boundary cache", async () => {
    const { path, ref } = fixture();
    const reading = transcriptImageAsync(path, ref);
    await new Promise<void>((resolve) => setImmediate(resolve));
    appendFileSync(path, line({ type: "assistant", uuid: id(4), parentUuid: id(3), message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } }));
    transcriptPage("claude-transcript", path);
    exact(await transcriptImageAsync(path, ref));
    exact(await reading);
    exact(await transcriptImageAsync(path, ref));
    appendFileSync(path, line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }));
    expect(await transcriptImageAsync(path, ref)).toBeNull();
  });
});

it("a lookup rejected after an in-place rewrite and growth leaves no stale boundary behind for the next lookup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-image-stale-boundary-"));
  roots.push(dir);
  const path = join(dir, "log.jsonl");
  const uuid = "00000000-0000-4000-8000-000000000001";
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const picture = JSON.stringify({ type: "user", uuid, message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] } }) + "\n";
  const clear = JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }) + "\n";
  const same = JSON.stringify({ type: "progress", data: "x".repeat(clear.length - 30) }) + "\n";
  expect(same.length).toBe(clear.length);
  const padding = JSON.stringify({ type: "progress", data: "x".repeat(1024 * 1024) }) + "\n";
  writeFileSync(path, picture + same + padding.repeat(3));
  let starts = 0;
  let changed = false;
  const read = fs.readSync;
  // the second whole-window read from the start is the boundary scan's, after the fingerprint: rewrite the record
  // after the picture into a /clear (same length, same inode) and append, while the lookup is paused
  const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const result = read(...args);
    const at = args as unknown as [number, Uint8Array, number, number, number];
    if (at[4] === 0 && at[3] === 1024 * 1024 && ++starts === 2) setImmediate(() => {
      writeFileSync(path, picture + clear + padding.repeat(3));
      appendFileSync(path, JSON.stringify({ type: "progress", data: "append" }) + "\n");
      changed = true;
    });
    return result;
  }) as typeof fs.readSync);
  try {
    expect(await transcriptImageAsync(path, `${uuid}:0`)).toBeNull();
    expect(changed).toBe(true);
  } finally { watch.mockRestore(); }
  // the picture is now before a /clear: the next lookup must not reuse the rejected scan's boundary
  expect(await transcriptImageAsync(path, `${uuid}:0`)).toBeNull();
});
