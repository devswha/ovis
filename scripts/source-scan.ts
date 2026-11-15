/**
 * Helpers for the repo-wide convention tests (src/, server/ and scripts/conventions.test.ts):
 * they read the checked-in sources as text and fail with an instruction for the next change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const repo = join(import.meta.dir, "..");

export const read = (file: string): string => readFileSync(join(repo, file), "utf8");

/** Repository-relative paths matching a glob, sorted; `node_modules` is never included. */
export const files = (pattern: string): string[] =>
  [...new Bun.Glob(pattern).scanSync({ cwd: repo })].filter((file) => !file.split("/").includes("node_modules")).sort();

/** Throws one message, the instruction first and then each offender, when there are offenders. */
export function fail(offenders: string[], instruction: string): void {
  if (offenders.length) throw new Error(`${instruction}\n  ${offenders.join("\n  ")}`);
}

/**
 * The source with every comment blanked out, character for character (newlines kept, so offsets
 * and line numbers still match). Strings and template literals are kept as written, or blanked
 * too with `strings`, so that a brace or keyword inside one is not read as code. A `/` that
 * starts a regular expression literal is not told apart from division, which only matters for a
 * regex holding a quote or `//`; the files these tests read have none that matter.
 *
 * The scans run it over tens of megabytes, so it copies the text between comments and strings in
 * slices and finds the end of each with a regex rather than going character by character.
 */
export function stripComments(text: string, { strings = false } = {}): string {
  const out: string[] = [];
  const start = /\/[/*]|["'`]/g;
  let i = 0;
  for (let match = start.exec(text); match; match = start.exec(text)) {
    const at = match.index;
    out.push(text.slice(i, at));
    const ch = text[at]!;
    if (ch === "/") {
      const line = text[at + 1] === "/";
      const close = line ? text.indexOf("\n", at) : text.indexOf("*/", at + 2);
      const end = close < 0 ? text.length : line ? close : close + 2;
      out.push(blank(text.slice(at, end)));
      i = end;
    } else {
      // the body up to the closing quote; a backslash takes the next character along, and a quote other than ` ends at a newline
      const body = STRING_BODY[ch as keyof typeof STRING_BODY];
      body.lastIndex = at + 1;
      body.exec(text);
      const j = body.lastIndex;
      out.push(strings ? ch + blank(text.slice(at + 1, j)) + text.slice(j, j + 1) : text.slice(at, j + 1));
      i = j + 1;
    }
    start.lastIndex = i;
  }
  out.push(text.slice(i));
  return out.join("");
}

const STRING_BODY = { "'": /(?:[^'\\\n]|\\[\s\S]?)*/y, "\"": /(?:[^"\\\n]|\\[\s\S]?)*/y, "`": /(?:[^`\\]|\\[\s\S]?)*/y };

/** `text` with every character but a newline turned into a space. */
const blank = (text: string): string => text.split("\n").map((line) => " ".repeat(line.length)).join("\n");

/** The 1-based line of an offset. */
export const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;
