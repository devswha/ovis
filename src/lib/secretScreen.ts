import type { Terminal } from "@xterm/xterm";
import { promptAsks, promptHasCursor, secretPrompt } from "../../shared/secret-prompt.ts";

/**
 * The masked prompt a terminal's screen shows now, if any (shared/secret-prompt.ts), read off xterm's screen.
 * `cursorKnown`: whether the screen's cursor is the program's (an attached pane). A mirrored pane's repaints carry
 * none, so its prompt counts while it is the last text; so does one not known to be attached. `forget` when the
 * screen starts over.
 */
export function createSecretScreen(term: Terminal, cursorKnown: () => boolean): { read: () => string | null; forget: () => void } {
  // the asking last seen with the cursor on its line (promptAsks)
  let seen: string | null = null;
  return {
    read(): string | null {
      const lines: string[] = [];
      // each line's first screen row
      const starts: number[] = [];
      const buffer = term.buffer.active;
      // the screen only: a prompt is on its last lines, and a herdr-core pane's history (syncHistory) would
      // cost every output frame a pass over its 2,000 lines
      for (let row = buffer.baseY; row < buffer.length; row++) {
        const line = buffer.getLine(row);
        const text = line?.translateToString(!buffer.getLine(row + 1)?.isWrapped) ?? "";
        if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
        else { lines.push(text); starts.push(row); }
      }
      const prompt = secretPrompt(lines.join("\n"), term.cols);
      if (!cursorKnown()) return prompt;
      // Which asking this is: the prompt with the line above it. The same words under another line are a prompt
      // printed again (a script that asks twice), not the one whose cursor was seen to leave. A line above stays
      // with its prompt when the screen scrolls, which herdr redraws a row higher
      let last = lines.length - 1;
      while (last >= 0 && !lines[last]!.trim()) last--;
      const asking = prompt === null ? null : `${last > 0 ? lines[last - 1]!.trimEnd() : ""}\n${prompt}`;
      const read = promptAsks(asking, prompt !== null && promptHasCursor(lines, starts, buffer.baseY + buffer.cursorY, buffer.cursorX, term.cols), seen);
      seen = read.seen;
      return read.asks ? prompt : null;
    },
    // the screen starts over (another pane, a reconnect): what was seen was that screen's
    forget(): void { seen = null; },
  };
}
