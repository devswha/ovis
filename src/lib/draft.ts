export interface InputDraft {
  readonly text: string;
  readonly truncated: boolean;
  readonly leftOut: boolean;
}

export const EMPTY_DRAFT: InputDraft = { text: "", truncated: false, leftOut: false };

const MAX_DRAFT_CHARS = 1024;

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredDraft extends InputDraft { at: number }

export function restoreDraft(raw: string | null, now: number): InputDraft {
  if (raw === null) return EMPTY_DRAFT;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return EMPTY_DRAFT; }
  if (typeof value !== "object" || value === null) return EMPTY_DRAFT;
  const { text, truncated, leftOut, at } = value as Partial<StoredDraft>;
  if (typeof text !== "string") return EMPTY_DRAFT;
  if (at !== undefined && (typeof at !== "number" || !Number.isFinite(at) || now - at > DRAFT_TTL_MS)) return EMPTY_DRAFT;
  return { text, truncated: truncated === true, leftOut: leftOut === true };
}

function isPrintableChar(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f-\x9f]/u.test(data);
}

const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

const ERASE = /^[\x7f\b\x17]+/;

const LINE_BREAKS = /[\r\n]+/g;

export function applyToDraft(draft: InputDraft, data: string): InputDraft {
  const pasted = BRACKETED_PASTE.exec(data)?.[1];
  let text = pasted?.replace(/\t/g, " ") ?? data;
  let next = draft;
  const erase = pasted === undefined ? ERASE.exec(text)?.[0].length ?? 0 : 0;
  if (erase > 0) {
    if (!draft.truncated) {
      const points = Array.from(draft.text);
      for (const key of text.slice(0, erase)) {
        if (key !== "\x17") { points.pop(); continue; }
        while (points.length > 0 && /\s/u.test(points.at(-1)!)) points.pop();
        while (points.length > 0 && !/\s/u.test(points.at(-1)!)) points.pop();
      }
      const kept = points.join("");
      next = kept.length === 0 ? EMPTY_DRAFT : { ...draft, text: kept };
    }
    text = text.slice(erase);
    if (text.length === 0) return next.text === draft.text && next.leftOut === draft.leftOut ? draft : next;
  }
  // a typed chunk with ESC is a key sequence (Shift+Enter or Alt+Enter is ESC CR), not text: never held, never told
  if (pasted === undefined && text.includes("\x1b")) return next;
  if (/[\r\n]/.test(text)) {
    let joined = text.replace(LINE_BREAKS, " ");
    if (next.text.length === 0 || next.text.endsWith(" ")) joined = joined.replace(/^ /, "");
    if (joined.length === 0 && next.text.length === 0) return next;
    const flagged = next.leftOut ? next : { ...next, leftOut: true };
    if (joined.length === 0) return flagged;
    if (!isPrintableChar(joined)) return flagged.truncated ? flagged : { ...flagged, truncated: true };
    return append(flagged, joined);
  }
  if (!isPrintableChar(text)) {
    if (pasted === undefined || text.length === 0 || next.truncated) return next;
    return { ...next, truncated: true };
  }
  return append(next, text);
}

export function holdBefore(chunks: readonly string[], draft: InputDraft): InputDraft {
  const lost = chunks.reduce((held, chunk) => applyToDraft(held, chunk), EMPTY_DRAFT);
  if (draftIsEmpty(lost)) return draft;
  if (draftIsEmpty(draft)) return lost;
  return append({ text: lost.text, truncated: lost.truncated || draft.truncated, leftOut: lost.leftOut || draft.leftOut }, draft.text);
}

function append(draft: InputDraft, text: string): InputDraft {
  if (draft.text.length + text.length > MAX_DRAFT_CHARS) return draft.truncated ? draft : { ...draft, truncated: true };
  return { ...draft, text: draft.text + text };
}

export function draftIsEmpty(draft: InputDraft): boolean {
  return draft.text.length === 0 && !draft.truncated && !draft.leftOut;
}
