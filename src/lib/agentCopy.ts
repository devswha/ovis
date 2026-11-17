import { herdrWidthProvider } from "./terminalWidths.ts";

const MARKER = /^(?:[⏺●•◦▪*+-]|[⎿└]|\d{1,3}[.)])\s+/u;
const BOX = /[\u2500-\u257f|]/u;
const CONTEXT_WORDS = 3;

let widths: ReturnType<typeof herdrWidthProvider> | undefined;

function cells(text: string): number {
  widths ??= herdrWidthProvider();
  let count = 0;
  for (const char of text) count += widths.wcwidth(char.codePointAt(0)!);
  return count;
}

const leading = (text: string): number => text.length - text.trimStart().length;

const plain = (text: string): string => text.replace(/[`*]/g, "").replace(/[ \t]+/g, " ").replace(/ ?\n */g, "\n");

function joinIn(said: readonly string[], before: string, after: string): " " | "" | null {
  const has = (joint: string): boolean => said.some((text) => text.includes(before + joint + after));
  if (has("\n")) return null;
  const spaced = has(" ");
  const unspaced = has("");
  return spaced === unspaced ? null : spaced ? " " : "";
}

export function unwrapAgentRows(text: string, cols: number, firstCol: number, said: readonly string[]): string {
  if (said.length === 0) return text;
  const written = said.map(plain);
  // xterm joins rows with \r\n on Windows
  const parts = text.split(/(\r?\n)/);
  let joined = parts[0]!;
  let row = joined;
  let rowStart = firstCol;
  let hanging = rowStart + leading(row) + (MARKER.exec(row.trimStart())?.[0].length ?? 0);
  for (let i = 1; i < parts.length; i += 2) {
    const separator = parts[i]!;
    const next = parts[i + 1]!;
    const indent = leading(next);
    const rest = next.slice(indent);
    const above = row.trimEnd();
    const end = rowStart + cells(above);
    const words = plain(rest).split(" ");
    const wraps = indent > 0 && indent === hanging && rest !== "" && above.trim() !== ""
      && end <= cols && end + 1 + cells(words[0]!) > cols
      && !BOX.test(above.at(-1)!) && !BOX.test(rest[0]!);
    const before = plain(above.trimStart().replace(MARKER, "")).split(" ").slice(-CONTEXT_WORDS).join(" ");
    const joint = wraps ? joinIn(written, before, words.slice(0, CONTEXT_WORDS).join(" ")) : null;
    if (joint !== null) joined = joined.trimEnd() + joint + rest;
    else {
      joined += separator + next;
      hanging = indent + (MARKER.exec(rest)?.[0].length ?? 0);
    }
    row = next;
    rowStart = 0;
  }
  return joined;
}
