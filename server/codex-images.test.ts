import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationPart } from "../shared/protocol.ts";
import { codexImageParts, codexTranscriptImage, imageType } from "./codex-images.ts";
import { parseCodexTranscript } from "./codex.ts";
import { codexToolImage, forgetTranscriptState, transcriptPage } from "./conversation.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=", "base64");
const data = `data:image/png;base64,${png.toString("base64")}`;
const event = (message: string, local_images: string[]) => ({ type: "event_msg", timestamp: "2026-09-27T00:00:00Z", payload: { type: "user_message", message, local_images } });
const response = (text: string, image: string) => ({ type: "response_item", timestamp: "2026-09-27T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text }, { type: "input_image", image_url: image }] } });
const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");

it("preserves image-only Codex turns and pairs event/response copies in either order", () => {
  for (const text of ["", "What is this?"]) {
    for (const records of [[event(text, ["/tmp/shot.png"]), response(text, data)], [response(text, data), event(text, ["/tmp/shot.png"])]]) {
      const turns = parseCodexTranscript(jsonl(...records));
      expect(turns).toHaveLength(1);
      expect(turns[0]!.parts.filter((part) => part.kind === "image")).toEqual(codexImageParts(event(text, ["/tmp/shot.png"])));
      expect(JSON.stringify(turns)).not.toContain(png.toString("base64"));
      expect(JSON.stringify(turns)).not.toContain("/tmp/shot.png");
    }
  }
  expect(parseCodexTranscript(jsonl(event("", ["one.png"]), event("", ["two.png"])))).toHaveLength(2);
  expect(parseCodexTranscript(jsonl(response("", data)))[0]?.parts).toEqual(codexImageParts(response("", data)));
});

it("strips Codex's native image envelope but keeps user-typed lookalikes", () => {
  const withEnvelope = {
    type: "response_item", timestamp: "2026-09-27T00:00:00Z",
    payload: { type: "message", role: "user", content: [
      { type: "input_text", text: '<image name=[Image #1] path="/tmp/yellow-star.gif">' },
      { type: "input_image", image_url: data },
      { type: "input_text", text: "</image>" },
      { type: "input_text", text: "[Image #1]" },
    ] },
  };
  const regressionTurns = parseCodexTranscript(jsonl(withEnvelope));
  const regressionUser = regressionTurns[0]!;
  expect(regressionUser.parts.filter((part) => part.kind === "text").map((part) => part.text)).toEqual(["[Image #1]"]); // regression (fails on main)
  expect(regressionUser.parts.filter((part) => part.kind === "image")).toHaveLength(1); // regression (fails on main)
  expect(JSON.stringify(regressionUser)).not.toContain("/tmp/yellow-star.gif"); // regression (fails on main)

  // a pasted image's envelope has no path; two of them in one message
  const pasted = parseCodexTranscript(jsonl({
    type: "response_item", timestamp: "2026-09-27T00:00:00Z",
    payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "<image name=[Image #1]>" },
      { type: "input_image", image_url: data },
      { type: "input_text", text: "</image>" },
      { type: "input_text", text: "<image name=[Image #2]>" },
      { type: "input_image", image_url: data.replace("image/png", "image/gif") },
      { type: "input_text", text: "</image>" },
      { type: "input_text", text: "[Image #1] [Image #2] compare these" },
    ] },
  }))[0]!;
  expect(pasted.parts.filter((part) => part.kind === "text").map((part) => part.text)).toEqual(["[Image #1] [Image #2] compare these"]);
  expect(pasted.parts.filter((part) => part.kind === "image")).toHaveLength(2);

  const controlTurns = parseCodexTranscript(jsonl({
    type: "response_item", timestamp: "2026-09-27T00:00:00Z",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: 'I typed <image name=x> and </image> literally.' }] },
  }));
  expect(controlTurns[0]?.parts.filter((part) => part.kind === "text").map((part) => part.text))
    .toEqual(['I typed <image name=x> and </image> literally.']); // control
});

it("names a raster by its signature and refuses short or truncated prefixes", () => {
  const bytes = (...parts: (string | number[])[]) => Buffer.concat(parts.map((part) => typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part)));
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  expect(imageType(png)).toBe("image/png");
  expect(imageType(bytes(pngSignature))).toBe("image/png");
  expect(imageType(bytes(pngSignature.slice(0, 7)))).toBeNull();
  expect(imageType(bytes([255, 216, 255]))).toBe("image/jpeg");
  expect(imageType(bytes([255, 216]))).toBeNull();
  expect(imageType(bytes("GIF87a"))).toBe("image/gif");
  expect(imageType(bytes("GIF89a", [1, 0]))).toBe("image/gif");
  expect(imageType(bytes("GIF88a"))).toBeNull();
  expect(imageType(bytes("GIF89"))).toBeNull();
  expect(imageType(bytes("RIFF", [4, 0, 0, 0], "WEBP"))).toBe("image/webp");
  expect(imageType(bytes("RIFF", [4, 0, 0, 0], "WEB"))).toBeNull();
  expect(imageType(bytes("RIFF", [4, 0, 0, 0], "WAVE"))).toBeNull();
  // each letter with its high bit set: an ASCII decode would read these as the signatures
  expect(imageType(bytes([0xc7, 0xc9, 0xc6, 0x38, 0x37, 0xe1]))).toBeNull();
  expect(imageType(bytes([0xc7, 0xc9, 0xc6, 0x38, 0x39, 0xe1]))).toBeNull();
  expect(imageType(bytes([0xd2, 0xc9, 0xc6, 0xc6, 4, 0, 0, 0, 0xd7, 0xc5, 0xc2, 0xd0]))).toBeNull();
  expect(imageType(bytes("RIFF", [4, 0, 0, 0], [0xd7, 0xc5, 0xc2, 0xd0]))).toBeNull();
  expect(imageType(bytes("not an image"))).toBeNull();
  expect(imageType(Buffer.alloc(0))).toBeNull();
});

it("does not turn remote URLs, unsupported data, or assistant/tool content into images", () => {
  expect(codexImageParts(event("", ["https://host/shot.png", "file:///tmp/a.png", "data:image/svg+xml;base64,PHN2Zz4=", "bad\0.png"]))).toEqual([]);
  expect(codexImageParts({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "input_image", image_url: data }] } })).toEqual([]);
  expect(codexImageParts(event("", ["a.png", "a.png"]))).toHaveLength(1);
});

it("fetches only referenced raster images within the retained history and bounds local reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-images-"));
  try {
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "shot.png"), png);
    const path = join(root, "rollout.jsonl");
    const record = event("", ["assets/shot.png"]);
    const first = `${jsonl(record)}\n`;
    writeFileSync(path, first + jsonl(response("", data)));
    const ref = codexImageParts(record)[0]!.ref;
    const inlineRef = codexImageParts(response("", data))[0]!.ref;
    const segment = { path, end: Buffer.byteLength(first) };
    const found = await codexTranscriptImage([segment], ref, root);
    expect(found?.mediaType).toBe("image/png");
    expect(Buffer.from(found!.bytes)).toEqual(png);
    expect(await codexTranscriptImage([segment], inlineRef, root)).toBeNull();
    expect(await codexTranscriptImage([{ path, end: Buffer.byteLength(first + jsonl(response("", data))) }], inlineRef, root)).toEqual(found);
    expect(await codexTranscriptImage([segment], "../../etc/passwd", root)).toBeNull();
    expect(await codexTranscriptImage([segment], `codex-${"0".repeat(64)}`, root)).toBeNull();
    writeFileSync(join(root, "assets", "shot.png"), "<html>not an image</html>");
    expect(await codexTranscriptImage([segment], ref, root)).toBeNull();
    writeFileSync(join(root, "assets", "shot.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(await codexTranscriptImage([segment], ref, root)).toBeNull();
    rmSync(join(root, "assets", "shot.png"));
    expect(await codexTranscriptImage([segment], ref, root)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A real codex-cli 0.163.0 rollout (`codex exec` in /tmp/codex-pictures, then `codex exec resume`):
// a prompt with `-i shot.png`, then `view_image` on it through the exec tool, whose output carries the
// picture as a data URL beside an `ImageView` event. Only the records the chat reads are kept.
const ROLLOUT = readFileSync(new URL("./fixtures/codex-pictures-0.163.0-rollout.jsonl", import.meta.url), "utf8");
const VIEWED = "call_c14dcc9fd54946c7bc093bac1ec706fd";
/** The sha256 of the 32x32 PNG the recording viewed. */
const SHOT = "216412999d849811ca002949953aa22a041cebcf0b31e7c812ee86328338b893";

describe("a Codex tool's pictures reach the chat", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-codex-tool-images-"));
  const home = join(root, "codex-home");
  afterAll(() => { rmSync(root, { recursive: true, force: true }); forgetTranscriptState(); });
  const header = ROLLOUT.split("\n")[0]!;
  let files = 0;
  const rollout = (text: string) => {
    files += 1;
    const path = join(root, `rollout-2026-10-26T18-01-48-01a17771-c993-7f01-9f21-${String(files).padStart(12, "0")}.jsonl`);
    writeFileSync(path, text);
    return path;
  };
  const pictures = (path: string) => transcriptPage("codex-transcript", path, {}, home).turns.flatMap((turn) => turn.parts)
    .flatMap((part: ConversationPart) => part.kind === "tool" ? (part.images ?? []).map((image) => `${image.media_type} ${image.ref}`) : []);
  const sha = (path: string, ref: string) => {
    const image = codexToolImage(path, ref, home);
    return image === null ? null : `${image.mediaType} ${createHash("sha256").update(image.bytes).digest("hex")}`;
  };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=", "base64");
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const url = (bytes: Buffer, type = "image/png") => `data:${type};base64,${bytes.toString("base64")}`;
  const picture = (bytes: Buffer, type = "image/png") => ({ type: "input_image", image_url: url(bytes, type), detail: "high" });
  const at = "2026-10-26T09:07:06.240Z";
  const call = (id: string, input = "await tools.view_image({path: 'shot.png'})") => ({ type: "response_item", timestamp: at, payload: { type: "custom_tool_call", call_id: id, name: "exec", input } });
  const output = (id: string, content: unknown[]) => ({ type: "response_item", timestamp: at, payload: { type: "custom_tool_call_output", call_id: id, output: content } });
  const records = (...entries: unknown[]) => [header, ...entries.map((entry) => JSON.stringify(entry))].join("\n") + "\n";
  const started = { type: "event_msg", timestamp: at, payload: { type: "task_started", turn_id: "t1" } };

  it("names the recorded view_image picture by its call, never its bytes, and serves those bytes", () => {
    const path = rollout(ROLLOUT);
    // one picture: the ImageView event beside the output is no second copy
    expect(pictures(path)).toEqual([`image/png codex-tool:${VIEWED}:0`]);
    expect(JSON.stringify(transcriptPage("codex-transcript", path, {}, home))).not.toContain("iVBORw0KGgo");
    expect(sha(path, `codex-tool:${VIEWED}:0`)).toBe(`image/png ${SHOT}`);
    for (const ref of [`codex-tool:${VIEWED}:1`, `codex-tool:${VIEWED}`, "codex-tool:call_other:0", `codex-tool:../${VIEWED}:0`, `pi:${VIEWED}:0`]) expect(codexToolImage(path, ref, home)).toBeNull();
  });

  it("numbers only the pictures the chat shows, by declared type and bytes, up to 8 MiB", () => {
    const exact = Buffer.alloc(8 * 1024 * 1024);
    png.copy(exact);
    const over = Buffer.alloc(8 * 1024 * 1024 + 1);
    png.copy(over);
    const path = rollout(records(started, call("call_a"), output("call_a", [
      { type: "input_text", text: "Script completed" },
      picture(Buffer.from("<svg/>"), "image/svg+xml"),
      picture(Buffer.from("not a picture")),
      { type: "input_image", image_url: "https://example.com/shot.png" },
      picture(gif, "image/gif"),
      picture(exact),
    ])));
    expect(pictures(path)).toEqual(["image/gif codex-tool:call_a:0", "image/png codex-tool:call_a:1"]);
    expect(sha(path, "codex-tool:call_a:0")).toBe(`image/gif ${createHash("sha256").update(gif).digest("hex")}`);
    expect(codexToolImage(path, "codex-tool:call_a:1", home)?.bytes.length).toBe(8 * 1024 * 1024);
    expect(codexToolImage(path, "codex-tool:call_a:2", home)).toBeNull();
    // a byte past the endpoint's size takes no place either
    const large = rollout(records(started, call("call_a"), output("call_a", [picture(over), picture(gif, "image/gif")])));
    expect(pictures(large)).toEqual(["image/gif codex-tool:call_a:0"]);
    expect(codexToolImage(large, "codex-tool:call_a:0", home)?.mediaType).toBe("image/gif");
    expect(codexToolImage(large, "codex-tool:call_a:1", home)).toBeNull();
  });

  it("serves a picture only from the output the page draws: the first one answering a call it shows", () => {
    // an output answering no call
    const orphan = rollout(records(started, output("call_a", [picture(png)])));
    expect(pictures(orphan)).toEqual([]);
    expect(codexToolImage(orphan, "codex-tool:call_a:0", home)).toBeNull();
    // a second output for an answered call
    const twice = rollout(records(started, call("call_a"), output("call_a", [{ type: "input_text", text: "none" }]), output("call_a", [picture(png)])));
    expect(pictures(twice)).toEqual([]);
    expect(codexToolImage(twice, "codex-tool:call_a:0", home)).toBeNull();
    // a call made again after an output with no picture: the second output's picture is the one named
    const again = rollout(records(started, call("call_a"), output("call_a", [{ type: "input_text", text: "none" }]), call("call_a"), output("call_a", [picture(gif, "image/gif")])));
    expect(pictures(again)).toEqual(["image/gif codex-tool:call_a:0"]);
    expect(codexToolImage(again, "codex-tool:call_a:0", home)?.mediaType).toBe("image/gif");
    // a function call's output is read as a custom tool's is
    const fn = rollout(records(started, { type: "response_item", timestamp: at, payload: { type: "function_call", call_id: "call_f", name: "view_image", arguments: "{\"path\":\"shot.png\"}" } },
      { type: "response_item", timestamp: at, payload: { type: "function_call_output", call_id: "call_f", output: [picture(png)] } }));
    expect(pictures(fn)).toEqual(["image/png codex-tool:call_f:0"]);
    expect(codexToolImage(fn, "codex-tool:call_f:0", home)?.mediaType).toBe("image/png");
  });

  it("reads a call id however JSON writes it, as the parser does", () => {
    const path = rollout(ROLLOUT.replaceAll(`"call_id":"${VIEWED}"`, `"call_id":"\\u0063all_${VIEWED.slice(5)}"`));
    expect(readFileSync(path, "utf8")).toContain("\\u0063all_");
    expect(pictures(path)).toEqual([`image/png codex-tool:${VIEWED}:0`]);
    expect(sha(path, `codex-tool:${VIEWED}:0`)).toBe(`image/png ${SHOT}`);
  });

  it("holds a window, a record's shape and the picture, never a record whole however large", () => {
    const alloc = spyOn(Buffer, "alloc");
    try {
      const pad = "x".repeat(20 * 1024 * 1024);
      // a call and its output, each padded past the largest picture the chat shows
      const path = rollout(records(started, call("call_a", pad), output("call_a", [{ type: "input_text", text: pad }, picture(png)])));
      expect(codexToolImage(path, "codex-tool:call_a:0", home)?.mediaType).toBe("image/png");
      alloc.mockClear();
      expect(Buffer.from(codexToolImage(path, "codex-tool:call_a:0", home)!.bytes).equals(png)).toBe(true);
      expect(Math.max(...alloc.mock.calls.map(([size]) => Number(size)))).toBeLessThanOrEqual(1024 * 1024);
    } finally { alloc.mockRestore(); }
  });
});
