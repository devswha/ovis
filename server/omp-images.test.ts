import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationPart } from "../shared/protocol.ts";
import { ompBlobPicture } from "./codex-images.ts";
import { forgetTranscriptState, ompTranscriptImage, transcriptPage } from "./conversation.ts";
import { ompBlobStore } from "./omp.ts";
import { turnStarts } from "./transcript-turns.ts";

// A real omp 18.8.7 session (`omp -p --model openai-codex/gpt-6-luna:medium` in /tmp/omp-pictures):
// `@shot.png` with a question, a `read` of shot.png, and `@shot.png` alone. omp turned the PNG into a
// WebP, moved its bytes to the agent's blob store and wrote `blob:sha256:<digest>` in their place.
const FIXTURE = readFileSync(new URL("./fixtures/omp-pictures-18.8.7-session.jsonl", import.meta.url), "utf8");
const BLOB = readFileSync(new URL("./fixtures/omp-pictures-18.8.7-blob.webp", import.meta.url));
const DIGEST = createHash("sha256").update(BLOB).digest("hex");
const CALL = (JSON.parse(FIXTURE.split("\n").find((line) => line.includes('"toolCall"'))!) as { message: { content: { id: string }[] } }).message.content[0]!.id;

const root = mkdtempSync(join(tmpdir(), "herdr-omp-images-"));
afterAll(() => { rmSync(root, { recursive: true, force: true }); forgetTranscriptState(); });

/** An omp agent directory holding one session of `text` and the blobs given, as omp lays them out. */
function store(name: string, text: string, blobs: Record<string, Buffer> = { [DIGEST]: BLOB }): { path: string; blobs: string } {
  const agent = join(root, name, "agent");
  const sessions = join(agent, "sessions", "-tmp-omp-pictures-");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(agent, "blobs"), { recursive: true });
  for (const [digest, bytes] of Object.entries(blobs)) writeFileSync(join(agent, "blobs", digest), bytes);
  const path = join(sessions, "2026-10-26T08-51-22-788Z_01a17768-3e24-721a-81f2-7b29ec922a6d.jsonl");
  writeFileSync(path, text);
  return { path, blobs: join(agent, "blobs") };
}
const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
type Pictured = Extract<ConversationPart, { kind: "image" }> | Extract<ConversationPart, { kind: "tool" }>;
/** Every turn's pictures, by ref: a prompt's own, then its tools'. */
const refs = (path: string): string[][] => transcriptPage("omp-transcript", path).turns.map((turn) => turn.parts.flatMap((part) => {
  const pictured = part as Pictured;
  return pictured.kind === "image" ? [`${pictured.media_type} ${pictured.ref}`] : pictured.kind === "tool" ? (pictured.images ?? []).map((image) => `${image.media_type} ${image.ref}`) : [];
}));
const served = (path: string, ref: string) => {
  const image = ompTranscriptImage(path, ref);
  return image === null ? null : { mediaType: image.mediaType, same: Buffer.from(image.bytes).equals(BLOB) };
};

// the records as omp 18.8.7 writes them, for cases the recording does not hold
const at = "2026-10-26T08:51:46.656Z";
const picture = (digest = DIGEST, mimeType = "image/webp") => ({ type: "image", data: `blob:sha256:${digest}`, mimeType });
const prompt = (id: string, content: unknown[]) => ({ type: "message", id, parentId: null, timestamp: at, message: { role: "user", content, attribution: "user", timestamp: 1 } });
const call = (entry: string, id: string) => ({ type: "message", id: entry, parentId: "u1", timestamp: at, message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "shot.png" } }], stopReason: "toolUse", timestamp: 2 } });
const result = (entry: string, id: string, content: unknown[]) => ({ type: "message", id: entry, parentId: "a1", timestamp: at, message: { role: "toolResult", toolCallId: id, toolName: "read", content, isError: false, timestamp: 3 } });
const answer = (entry: string, text: string) => ({ type: "message", id: entry, parentId: "r1", timestamp: at, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 4 } });
const clear = { type: "custom", customType: "context_clear", id: "x1", parentId: "a2", timestamp: at };

describe("omp's pictures reach the chat", () => {
  it("names the recorded session's prompt and tool pictures by ref only, and serves their exact bytes", () => {
    const { path } = store("recorded", FIXTURE);
    expect(refs(path)).toEqual([
      ["image/webp pi-prompt:d4a9dbba:0"], [],
      [], [`image/webp pi:${CALL}:0`],
      ["image/webp pi-prompt:faaa5772:0"], [],
    ]);
    // only refs reach the page: no picture bytes, and no blob ref either
    const page = JSON.stringify(transcriptPage("omp-transcript", path));
    expect(page).not.toContain(BLOB.toString("base64").slice(0, 32));
    expect(page).not.toContain("blob:sha256");
    for (const ref of ["pi-prompt:d4a9dbba:0", `pi:${CALL}:0`, "pi-prompt:faaa5772:0"]) expect(served(path, ref)).toEqual({ mediaType: "image/webp", same: true });
    // no picture at that place, an entry with none, a ref that is no ref
    for (const ref of ["pi-prompt:d4a9dbba:1", `pi:${CALL}:1`, "pi-prompt:5cd289cf:0", "pi-prompt:d4a9dbba", `pi:${CALL.split("|")[0]}:0`, "pi-prompt:../d4a9dbba:0"]) expect(ompTranscriptImage(path, ref)).toBeNull();
  });

  it("finds the blob store beside omp's managed store, and none for a session directory of its own", () => {
    expect(ompBlobStore("/home/u/.omp/agent/sessions/-home-u-p-/s.jsonl")).toBe("/home/u/.omp/agent/blobs");
    // a subagent's file, a level below its parent session
    expect(ompBlobStore("/home/u/.omp/agent/sessions/-home-u-p-/s/sub.jsonl")).toBe("/home/u/.omp/agent/blobs");
    expect(ompBlobStore("/data/omp/sessions/-home-u-p-/s.jsonl")).toBe("/data/omp/blobs");
    expect(ompBlobStore("/somewhere/own-dir/s.jsonl")).toBeNull();
  });

  it("names and serves a blob only when its bytes are the picture the transcript recorded", () => {
    const records = jsonl(prompt("u1", [{ type: "text", text: "look" }, picture()]), answer("a1", "a webp"));
    const ok = store("blob-ok", records);
    expect(refs(ok.path)).toEqual([["image/webp pi-prompt:u1:0"], []]);
    // no blob: the prompt's words stay, with no picture named
    const missing = store("blob-missing", records, {});
    expect(refs(missing.path)).toEqual([[], []]);
    expect(ompTranscriptImage(missing.path, "pi-prompt:u1:0")).toBeNull();
    // bytes that do not hash to the name the transcript gave them
    const tampered = store("blob-tampered", records, { [DIGEST]: Buffer.concat([BLOB, Buffer.from("x")]) });
    expect(refs(tampered.path)).toEqual([[], []]);
    expect(ompTranscriptImage(tampered.path, "pi-prompt:u1:0")).toBeNull();
    // a link in the store is not followed, even to the right bytes
    const linked = store("blob-linked", records, {});
    writeFileSync(join(root, "elsewhere.webp"), BLOB);
    symlinkSync(join(root, "elsewhere.webp"), join(linked.blobs, DIGEST));
    expect(ompBlobPicture(linked.blobs, "image/webp", `blob:sha256:${DIGEST}`)).toBeNull();
    expect(ompTranscriptImage(linked.path, "pi-prompt:u1:0")).toBeNull();
  });

  it("names only a raster the chat shows, by its declared type and its bytes, up to 8 MiB", () => {
    const blob = (bytes: Buffer) => ({ digest: createHash("sha256").update(bytes).digest("hex"), bytes });
    const svg = blob(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"));
    const png = (size: number) => { const bytes = Buffer.alloc(size); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes); return blob(bytes); };
    const exact = png(8 * 1024 * 1024);
    const over = png(8 * 1024 * 1024 + 1);
    const { path } = store("blob-types", jsonl(prompt("u1", [
      { type: "text", text: "these" },
      picture(svg.digest, "image/png"),
      picture(DIGEST, "image/svg+xml"),
      picture(over.digest, "image/png"),
      picture(exact.digest, "image/png"),
      // a ref that is no digest omp writes: never read
      { type: "image", data: "blob:sha256:../../etc/passwd", mimeType: "image/png" },
      { type: "image", data: `blob:sha256:${DIGEST.toUpperCase()}`, mimeType: "image/webp" },
      picture(),
    ]), answer("a1", "two")), { [DIGEST]: BLOB, [svg.digest]: svg.bytes, [exact.digest]: exact.bytes, [over.digest]: over.bytes });
    // each refused one takes no place, so a ref can never point aside
    expect(refs(path)).toEqual([["image/png pi-prompt:u1:0", "image/webp pi-prompt:u1:1"], []]);
    expect(ompTranscriptImage(path, "pi-prompt:u1:0")?.bytes.length).toBe(8 * 1024 * 1024);
    expect(served(path, "pi-prompt:u1:1")).toEqual({ mediaType: "image/webp", same: true });
    expect(ompTranscriptImage(path, "pi-prompt:u1:2")).toBeNull();
  });

  it("shows a prompt that is only a picture as its own turn, and opens a page there", () => {
    const records = [prompt("u1", [{ type: "text", text: "first" }]), answer("a1", "one"), prompt("u2", [picture()]), answer("a2", "two")];
    const { path, blobs } = store("picture-only", jsonl(...records));
    expect(refs(path)).toEqual([[], [], ["image/webp pi-prompt:u2:0"], []]);
    expect(transcriptPage("omp-transcript", path).turns[2]!.parts.map((part) => part.kind)).toEqual(["image"]);
    expect(served(path, "pi-prompt:u2:0")).toEqual({ mediaType: "image/webp", same: true });
    const rows = records.map((row) => JSON.stringify(row));
    const bytes = Buffer.from(rows.join("\n"));
    const second = rows[0]!.length + rows[1]!.length + 2;
    expect(turnStarts(bytes, "omp-transcript", undefined, blobs)).toEqual([0, second]);
    // with no blob to show, it is no turn the parser draws, and opens none
    expect(turnStarts(bytes, "omp-transcript", undefined, join(root, "no-blobs"))).toEqual([0]);
  });

  it("serves a tool's picture only from the result the page draws: the first one answering a call it shows", () => {
    const shown = [prompt("u1", [{ type: "text", text: "read it" }]), call("a1", "c1")];
    // a second result for an answered call
    const twice = store("tool-twice", jsonl(...shown, result("r1", "c1", [{ type: "text", text: "nothing" }]), result("r2", "c1", [picture()]), answer("a2", "done")));
    expect(refs(twice.path).flat()).toEqual([]);
    expect(ompTranscriptImage(twice.path, "pi:c1:0")).toBeNull();
    // a result answering no call the page draws
    const orphan = store("tool-orphan", jsonl(...shown, result("r1", "c2", [picture()]), answer("a2", "done")));
    expect(refs(orphan.path).flat()).toEqual([]);
    expect(ompTranscriptImage(orphan.path, "pi:c2:0")).toBeNull();
    // a call made again after an answer with no picture: the second answer's picture is the one named
    const again = store("tool-again", jsonl(...shown, result("r1", "c1", [{ type: "text", text: "nothing" }]), call("a2", "c1"), result("r2", "c1", [picture()]), answer("a3", "done")));
    expect(refs(again.path).flat()).toEqual(["image/webp pi:c1:0"]);
    expect(served(again.path, "pi:c1:0")).toEqual({ mediaType: "image/webp", same: true });
  });

  it("puts a picture from before a clear out of reach, a clear however JSON writes it", () => {
    const records = jsonl(prompt("u1", [{ type: "text", text: "read it" }, picture()]), call("a1", "c1"), result("r1", "c1", [picture()]), answer("a2", "done"), clear);
    const cleared = store("cleared", records);
    expect(transcriptPage("omp-transcript", cleared.path).turns).toEqual([]);
    expect(ompTranscriptImage(cleared.path, "pi-prompt:u1:0")).toBeNull();
    expect(ompTranscriptImage(cleared.path, "pi:c1:0")).toBeNull();
    const escaped = store("cleared-escaped", records.replace('"customType":"context_clear"', '"customType":"context\\u005fclear"'));
    expect(transcriptPage("omp-transcript", escaped.path).turns).toEqual([]);
    expect(ompTranscriptImage(escaped.path, "pi-prompt:u1:0")).toBeNull();
    expect(ompTranscriptImage(escaped.path, "pi:c1:0")).toBeNull();
  });

  it("reads a call id and an entry id however JSON writes them, as the parser does", () => {
    // omp's own call ids hold a `|`; here it and a letter are written as escapes
    const text = FIXTURE.replaceAll(JSON.stringify(CALL), JSON.stringify(CALL).replace("|", "\\u007c").replace("call_", "\\u0063all_"))
      .replace('"id":"d4a9dbba"', '"id":"\\u00644a9dbba"');
    expect(text).toContain("\\u007c");
    const { path } = store("escaped-ids", text);
    expect(refs(path)[0]).toEqual(["image/webp pi-prompt:d4a9dbba:0"]);
    expect(refs(path)[3]).toEqual([`image/webp pi:${CALL}:0`]);
    expect(served(path, "pi-prompt:d4a9dbba:0")).toEqual({ mediaType: "image/webp", same: true });
    expect(served(path, `pi:${CALL}:0`)).toEqual({ mediaType: "image/webp", same: true });
  });

  it("names the same pictures as a session grows as a cold read does", () => {
    const lines = FIXTURE.split("\n");
    const cut = lines.findIndex((line) => line.includes('"toolResult"'));
    const { path } = store("growing", lines.slice(0, cut).join("\n") + "\n");
    expect(refs(path).flat()).toEqual(["image/webp pi-prompt:d4a9dbba:0"]);
    appendFileSync(path, lines.slice(cut).join("\n"));
    const warm = refs(path);
    forgetTranscriptState();
    expect(warm).toEqual(refs(path));
    expect(warm.flat()).toEqual(["image/webp pi-prompt:d4a9dbba:0", `image/webp pi:${CALL}:0`, "image/webp pi-prompt:faaa5772:0"]);
  });

  it("holds a window, a record's shape and the picture, never a record whole however large", () => {
    const alloc = spyOn(Buffer, "alloc");
    try {
      const pad = "x".repeat(20 * 1024 * 1024);
      // a call and its result, each padded past the largest picture the chat shows
      const { path } = store("large", jsonl(prompt("u1", [{ type: "text", text: "read it" }]),
        { ...call("a1", "c1"), message: { ...call("a1", "c1").message, content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "shot.png", pad } }] } },
        result("r1", "c1", [{ type: "text", text: pad }, picture()]), answer("a2", "done")));
      // the first read scans the history once; the endpoint's own reads are what is left
      expect(served(path, "pi:c1:0")).toEqual({ mediaType: "image/webp", same: true });
      alloc.mockClear();
      expect(served(path, "pi:c1:0")).toEqual({ mediaType: "image/webp", same: true });
      expect(Math.max(...alloc.mock.calls.map(([size]) => Number(size)))).toBeLessThanOrEqual(1024 * 1024);
    } finally { alloc.mockRestore(); }
  });
});
