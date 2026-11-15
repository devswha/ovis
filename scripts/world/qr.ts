/**
 * B3: the link a machine's terminal printed as a QR code (`ovis add`), read back as text, offline. The terminal draws
 * it with the repository's own encoder (qrcode-generator, `createASCII(1, 1)` in scripts/plugin-link.ts): half blocks,
 * a dark module drawn as a space. The drawing is exact, so no camera decoding is needed: the modules are read straight
 * off the matrix, with the block table and alignment positions taken from that library's own source, every mask is
 * tried, and an answer counts only when the same encoder draws it again to the very same text.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import qrcode from "qrcode-generator";

const LEVEL_M = 1;
const MASKS: readonly ((row: number, col: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (_i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => (i * j) % 2 + (i * j) % 3 === 0,
  (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0, (i, j) => ((i * j) % 3 + (i + j) % 2) % 2 === 0,
];

/** The library's own tables, read from its source: they decide where the modules and blocks are. */
function tables(): { blocks: number[][]; alignment: number[][] } {
  const source = readFileSync(join(dirname(Bun.resolveSync("qrcode-generator", import.meta.dir)), "qrcode.mjs"), "utf8");
  const table = (name: string) => {
    const found = new RegExp(`${name} = (\\[[\\s\\S]*?\\n\\s*\\]);`).exec(source)?.[1];
    if (found === undefined) throw new Error(`qrcode-generator has no ${name}`);
    return JSON.parse(found.replace(/\/\/[^\n]*/g, "").replace(/,(\s*\])/g, "$1")) as number[][];
  };
  return { blocks: table("RS_BLOCK_TABLE"), alignment: table("PATTERN_POSITION_TABLE") };
}

/** The drawing as dark (true) and light modules, without its one-module margin. */
export function modules(drawing: string): boolean[][] {
  const lines = drawing.replace(/\n+$/, "").split("\n");
  const width = lines[0]?.length ?? 0;
  const cells: Record<string, [boolean, boolean]> = { "█": [false, false], "▀": [false, true], "▄": [true, false], " ": [true, true] };
  const rows: boolean[][] = [];
  for (const line of lines) {
    if (line.length !== width) throw new Error("not a QR drawing: lines of different widths");
    const pairs = [...line].map((char) => cells[char] ?? (() => { throw new Error(`not a QR drawing: ${JSON.stringify(char)}`); })());
    rows.push(pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1]));
  }
  return rows.slice(1, width - 1).map((row) => row.slice(1, width - 1));
}

function reserved(size: number, alignment: readonly number[]): boolean[][] {
  const taken = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const mark = (row: number, col: number) => { if (row >= 0 && col >= 0 && row < size && col < size) taken[row]![col] = true; };
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(top + r, left + c);
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const row of alignment) for (const col of alignment) {
    if ((row < 9 && col < 9) || (row < 9 && col > size - 10) || (row > size - 10 && col < 9)) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) mark(row + r, col + c);
  }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  if (size >= 45) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(i, size - 11 + j); mark(size - 11 + j, i); }
  return taken;
}

function readWith(matrix: boolean[][], mask: number, version: number, kept: ReturnType<typeof tables>): string | null {
  const size = matrix.length;
  const taken = reserved(size, kept.alignment[version - 1] ?? []);
  const bits: number[] = [];
  for (let col = size - 1, upward = true; col > 0; col -= 2, upward = !upward) {
    if (col === 6) col -= 1;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const c of [col, col - 1]) if (!taken[row]![c]) bits.push(Number(matrix[row]![c]! !== MASKS[mask]!(row, c)));
    }
  }
  const words: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((value, bit) => value * 2 + bit, 0));
  const entry = kept.blocks[(version - 1) * 4 + LEVEL_M]!;
  const sizes: number[] = [];
  for (let i = 0; i < entry.length; i += 3) for (let n = 0; n < entry[i]!; n++) sizes.push(entry[i + 2]!);
  const data: number[][] = sizes.map(() => []);
  let at = 0;
  for (let i = 0; i < Math.max(...sizes); i++) for (const [b, length] of sizes.entries()) if (i < length) data[b]!.push(words[at++] ?? 0);
  const stream = data.flat().flatMap((word) => Array.from({ length: 8 }, (_, k) => (word >> (7 - k)) & 1));
  const take = (count: number, from: number) => stream.slice(from, from + count).reduce((value, bit) => value * 2 + bit, 0);
  if (take(4, 0) !== 0b0100) return null;
  const countBits = version < 10 ? 8 : 16;
  const length = take(countBits, 4);
  // a wrong mask reads a length the data cannot hold: that mask is not the one
  if (4 + countBits + length * 8 > stream.length) return null;
  const bytes = Array.from({ length }, (_, i) => take(8, 4 + countBits + i * 8));
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

/** The text a terminal's QR drawing carries, proven by drawing it again; null when the drawing is not one of these. */
export function readQr(drawing: string): string | null {
  const matrix = modules(drawing);
  const version = (matrix.length - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 40) return null;
  const kept = tables();
  const wanted = drawing.replace(/\n+$/, "");
  for (let mask = 0; mask < 8; mask++) {
    const text = readWith(matrix, mask, version, kept);
    if (text === null) continue;
    let drawn: string;
    try {
      const again = qrcode(0, "M");
      again.addData(text);
      again.make();
      drawn = again.createASCII(1, 1).replace(/\n+$/, "");
    } catch {
      continue;
    }
    if (drawn === wanted) return text;
  }
  return null;
}

/** The last QR drawing in a terminal's recording, read back: the pairing link `ovis add` showed. */
export function lastQrLink(recording: string): string | null {
  // a full-screen drawing starts with escape sequences (other screen, home, clear) on the code's first line
  const plain = recording.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");
  const lines = plain.replace(/\r/g, "").split("\n");
  const isQr = (line: string) => line.length > 20 && /^[█▀▄ ]+$/.test(line);
  for (let end = lines.length - 1; end >= 0; end--) {
    if (!isQr(lines[end]!)) continue;
    let start = end;
    while (start > 0 && isQr(lines[start - 1]!) && lines[start - 1]!.length === lines[end]!.length) start--;
    const text = readQr(lines.slice(start, end + 1).join("\n"));
    if (text !== null) return text;
    end = start;
  }
  return null;
}
