/**
 * Hermes ignores a lone Escape; its interrupt is Ctrl+C, and that same key exits an idle Hermes
 * (measured on Hermes 0.21.5, classic CLI and TUI) and force-quits the classic CLI on a second
 * press within 2 s.
 */
export function hermesInterruptible(rows: readonly string[]): boolean {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    const at = row.indexOf("❯");
    if (at < 0) continue;
    const input = row.slice(at + 1).trim();
    return /^msg=\w+ · .*Ctrl\+C cancel$/.test(input) || /^Ctrl\+C to interrupt(?:…|\.\.\.)$/.test(input);
  }
  return false;
}

/** Hermes force-quits the classic CLI on a second Ctrl+C within this window of the first. */
export const HERMES_CTRL_C_WINDOW_MS = 2000;

export function hermesCtrlCTooSoon(lastCtrlCAt: number | null, now: number): boolean {
  return lastCtrlCAt !== null && now - lastCtrlCAt < HERMES_CTRL_C_WINDOW_MS;
}

export function grokCancellable(rows: readonly string[]): boolean {
  const last = [...rows].reverse().find((row) => row.trim() !== "");
  return last !== undefined && /(?:^|│)\s*Ctrl\+c:cancel\s*(?:│|$)/.test(last.trim());
}

const DOUBLE_ESCAPE_AGENTS: ReadonlySet<string> = new Set(["devin", "kilo", "maki"]);

export const DOUBLE_ESCAPE_GAP_MS = 150;

export type StopKey = "\u001b" | "\u001b\u001b" | "\u0003" | null;

export function stopKey(
  agent: string | null | undefined,
  rows: () => readonly string[],
  sentThisTurn: boolean,
  lastCtrlCAt: number | null,
  now: number,
): StopKey {
  if (agent === "hermes" || agent === "grok") {
    if (sentThisTurn || hermesCtrlCTooSoon(lastCtrlCAt, now)) return null;
    return (agent === "hermes" ? hermesInterruptible(rows()) : grokCancellable(rows())) ? "\u0003" : null;
  }
  return agent && DOUBLE_ESCAPE_AGENTS.has(agent) ? "\u001b\u001b" : "\u001b";
}
