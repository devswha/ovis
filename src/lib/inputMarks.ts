import { markTyped } from "./ws.ts";

/** The parts of a keydown that tell a plain key stroke. */
export type KeyStroke = Pick<KeyboardEvent, "key" | "keyCode" | "isComposing" | "ctrlKey" | "altKey" | "metaKey">;

/** Whether `data` is what the key stroke itself types: its character, or a named key's or a chord's control sequence. */
export function fromKeyStroke(stroke: KeyStroke | null, data: string): boolean {
  if (stroke === null || stroke.isComposing || stroke.keyCode === 229) return false;
  if (stroke.key.length === 1 && !stroke.ctrlKey && !stroke.altKey && !stroke.metaKey) return data === stroke.key;
  return data.length <= 16 && /^[\x00-\x1f\x7f]/.test(data) && !data.startsWith("\x1b[200~");
}

export interface InputMarks {
  /** a keydown reached the terminal (capture phase): what it types until keyEnd counts as typed now */
  keyDown(stroke: KeyStroke): void;
  /** the key stroke is over (its keyup, or an input or composition event that is not the key's own) */
  keyEnd(): void;
  /** the field may begin to take text now (beforeinput, compositionstart, paste): from an empty field, it counts from now */
  observe(): void;
  /** the mark (markTyped) of input the terminal emits now; `paste`: it came from a paste */
  take(data: string, paste: boolean): number;
}

/**
 * Marks input as the terminal emits it, failing closed. What a plain key stroke types is marked now. Any other text
 * (an input method's commit or replacement, dictation, a key reported as 229, a paste, a callback xterm runs later)
 * may have been entered at any time since the terminal's field was last seen empty, so it is marked then: when the
 * link was lost since, the socket's gate (HerdrSocket.takesKey) holds it, even if it is emitted after recovery.
 */
export function inputMarks(fieldEmpty: () => boolean, mark: () => number = markTyped): InputMarks {
  let stroke: KeyStroke | null = null;
  let quietAt = mark();
  const observe = (): void => { if (fieldEmpty()) quietAt = mark(); };
  return {
    keyDown: (event) => {
      observe();
      stroke = event;
    },
    keyEnd: () => { stroke = null; },
    observe,
    take: (data, paste) => {
      const at = !paste && fromKeyStroke(stroke, data) ? mark() : quietAt;
      observe();
      return at;
    },
  };
}
