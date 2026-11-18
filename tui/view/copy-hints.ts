import { fileUriPath } from "../../shared/fileUri.ts";
import { addressSpans, isWebLink, terminalPathMatches } from "../../shared/terminal-links.ts";
import type { PaneScene } from "./paint.ts";

type Token = { readonly index: number; readonly text: string };
const HASH = /(?:^|[^-\p{L}\p{N}_])([0-9a-f]{7,64})(?![-\p{L}\p{N}_])/giu;
// Explicit paths also name extensionless files and directories, which the browser's opener does not detect.
const EXPLICIT = /(?:^|[\s("'`])((?:~\/|\.\.?\/|\/)[\p{L}\p{N}\p{M}_@+-]+(?:\/[\p{L}\p{N}\p{M}_@+.-]+)*\/?)(?![\p{L}\p{N}\p{M}_@+./:-])/gu;

function tokens(text: string): Token[] {
  const spans = addressSpans(text);
  const addresses = spans.flatMap(([start, end]) => {
    const token = text.slice(start, end);
    const scheme = /[a-z][a-z0-9+.-]*:\/\//i.exec(token);
    if (!scheme) return [];
    const uri = token.slice(scheme.index).replace(/[),.;:!?'"`>]+$/, "");
    return (isWebLink(uri) && uri.length > scheme[0].length) || fileUriPath(uri) !== null
      ? [{ index: start + scheme.index, text: uri }] : [];
  });
  const paths = [...terminalPathMatches(text, false)].map(({ index, link }) => ({ index, text: link }));
  const other = [EXPLICIT, HASH].flatMap((pattern) => Array.from(text.matchAll(pattern), (match) => {
    const value = match[1] ?? "";
    return { index: match.index + match[0].length - value.length, text: value };
  })).filter(({ index }) => !spans.some(([start, end]) => index >= start && index < end)
    && !paths.some((path) => index >= path.index && index < path.index + path.text.length));
  return [...addresses, ...paths, ...other].sort((a, b) => a.index - b.index || b.text.length - a.text.length);
}

export interface CopyHint {
  readonly col: number;
  readonly row: number;
  readonly width: 1 | 2;
  readonly digit: number;
  readonly text: string;
}

/** Number only whole tokens in the drawn clip, using the actual cells to position labels after wide text. */
export function visibleCopyHints(scene: PaneScene): CopyHint[] {
  const { grid } = scene.grid;
  const { col, row } = scene.view ?? { col: 0, row: 0 };
  const hints: CopyHint[] = [];
  for (let y = row; y < Math.min(grid.rows, row + scene.rect.height); y++) {
    let text = "";
    const cells: number[] = [];
    for (let x = 0; x < grid.cols; x++) {
      const i = y * grid.cols + x;
      if (grid.width[i] === 0) continue;
      const value = grid.text[i] || " ";
      text += value;
      for (let at = 0; at < value.length; at++) cells.push(x);
    }
    let end = -1;
    for (const token of tokens(text)) {
      const x = cells[token.index], last = cells[token.index + token.text.length - 1];
      if (x === undefined || last === undefined || x < col || token.index < end) continue;
      const lastWidth = grid.width[y * grid.cols + last] === 2 ? 2 : 1;
      if (last + lastWidth > col + scene.rect.width) continue;
      // No token touches an ambiguous physical row edge in a wrapped or clipped line.
      if (last + lastWidth === grid.cols) continue;
      end = token.index + token.text.length;
      hints.push({
        col: scene.rect.x + x - col, row: scene.rect.y + y - row, digit: hints.length + 1, text: token.text,
        width: grid.width[y * grid.cols + x] === 2 ? 2 : 1,
      });
      if (hints.length === 9) return hints;
    }
  }
  return hints;
}
