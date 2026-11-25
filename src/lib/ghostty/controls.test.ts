import { expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { matchHerdrWidths } from "../terminalWidths.ts";
import { controlScanner, controlsWriter } from "./controls.ts";
import { GhosttyVt } from "./vt.ts";

const parse = (term: Terminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve));

const SESSION = "\x1b[?1049h\x1b[?2004h\x1b[?1h\x1b[?1000h\x1b[?1006h\x1b[>4;2m\x1b]0;a title\x07\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\"
  + "\x1b[2J\x1b[H\x1b[1;31m한글 prompt\x1b[0m $ \x1b[6n" + "x".repeat(70) + "\x1b[3;5H\x1b]52;c;aGVsbG8=\x07\x1b[?6n\x1b[c\x1b[>c\x1b[5n"
  + "\x1bPq#0;2;0;0;0#0~~\x1b\\\x1b_Gf=24;AAAA\x1b\\\x1b[?2026$p\x1b[14t\x1b[?25l\x1b[?1004h\r\nend\x1b[?25h";

test("the scanner takes the same controls from a stream however it is split", () => {
  const whole = controlScanner()(SESSION);
  const pieces = controlScanner();
  const split = [...SESSION].flatMap((ch) => pieces(ch));
  const flat = (list: typeof whole) => list.map((piece) => piece.controls + (piece.question ?? "")).join("");
  expect(flat(split)).toBe(flat(whole));
  expect(whole.map((piece) => piece.question).filter(Boolean)).toEqual(["\x1b[6n", "\x1b[?6n", "\x1b[c", "\x1b[>c", "\x1b[5n", "\x1b[?2026$p", "\x1b[14t"]);
  expect(flat(whole)).not.toContain("prompt");
  expect(flat(whole)).not.toContain("a title");
  expect(flat(whole)).toContain("\x1b]52;c;aGVsbG8=\x07");
});

async function compare(chunks: string[]): Promise<void> {
  const full = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
  const only = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
  for (const term of [full, only]) matchHerdrWidths(term);
  const vt = await GhosttyVt.create(40, 6);
  const replies = { full: [] as string[], only: [] as string[] };
  full.onData((data) => replies.full.push(data));
  only.onData((data) => replies.only.push(data));
  const writeOnly = controlsWriter(vt, (data, callback) => only.write(data, callback));
  try {
    for (const chunk of chunks) {
      await parse(full, chunk);
      await new Promise<void>((resolve) => writeOnly(chunk, resolve));
    }
    const { buffer: fb, modes: fm } = full, { buffer: ob, modes: om } = only;
    expect(om).toEqual(fm);
    expect([ob.active.type, ob.active.cursorX, ob.active.cursorY]).toEqual([fb.active.type, fb.active.cursorX, fb.active.cursorY]);
    expect(vt.screenCursor()).toEqual({ x: fb.active.cursorX, y: fb.active.cursorY });
    expect(replies.only).toEqual(replies.full);
    expect(replies.only.some((reply) => /^\x1b\[\d+;\d+R$/.test(reply))).toBe(true);
    expect(ob.active.getLine(0)?.translateToString(true)).toBe("");
  } finally {
    vt.dispose();
    full.dispose();
    only.dispose();
  }
}

test("xterm fed the controls alone keeps the modes, the cursor and the answers of an xterm fed everything", async () => {
  await compare([SESSION]);
});

test("the same holds when every frame is cut at any point, a question included", async () => {
  await compare(SESSION.match(/[\s\S]{1,7}/g)!);
});
