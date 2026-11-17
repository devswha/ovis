import type { Terminal } from "@xterm/xterm";
import { promptHasCursor, secretPrompt } from "../../shared/secret-prompt.ts";

interface Asking { prompt: string; repeats: number; cut: boolean }

function sameAsking(seen: Asking, now: Asking): boolean {
  return seen.prompt === now.prompt && (seen.repeats === now.repeats || (now.cut && now.repeats < seen.repeats));
}

export function createSecretScreen(term: Terminal, cursorKnown: () => boolean): { read: (pane: string) => string | null } {
  let seen: Asking | null = null;
  let seenOn: string | null = null;
  return {
    read(pane: string): string | null {
      if (pane !== seenOn) { seen = null; seenOn = pane; }
      const lines: string[] = [];
      const starts: number[] = [];
      const buffer = term.buffer.active;
      for (let row = buffer.baseY; row < buffer.length; row++) {
        const line = buffer.getLine(row);
        // As wide as the terminal and no wider: on the alternate screen, which herdr's attach draws on, a row keeps
        // the cells of a wider grid past the new edge, and herdr's redraw for a narrower one does not clear them
        const text = line?.translateToString(!buffer.getLine(row + 1)?.isWrapped, 0, term.cols) ?? "";
        if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
        else { lines.push(text); starts.push(row); }
      }
      const prompt = secretPrompt(lines.join("\n"), term.cols);
      if (!cursorKnown()) return prompt;
      if (prompt === null) { seen = null; return null; }
      let last = lines.length - 1;
      while (last >= 0 && !lines[last]!.trim()) last--;
      const words = lines[last]!.trimEnd();
      let first = last;
      while (first > 0 && lines[first - 1]!.trimEnd() === words) first--;
      const asking: Asking = { prompt, repeats: last - first, cut: first === 0 };
      if (promptHasCursor(lines, starts, buffer.baseY + buffer.cursorY, buffer.cursorX, term.cols)) { seen = asking; return prompt; }
      return seen !== null && sameAsking(seen, asking) ? null : prompt;
    },
  };
}
