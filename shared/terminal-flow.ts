/** Overloaded output stops this connection; automatic replay could conceal lost ANSI state. */
export const OUTPUT_STALLED_CLOSE_CODE = 4008;

/** Lines a herdr-core attach replays first (`ServerFeature` `terminal-history`). Also the max a device may keep in xterm. */
export const TERMINAL_HISTORY_LINES = 2000;

/** Choices for how many of those lines this device's terminal view keeps (Settings → Terminal → Terminal History). */
export const TERMINAL_HISTORY_LINE_OPTIONS = [10, 50, 100, 500, 1_000, TERMINAL_HISTORY_LINES] as const;
export type TerminalHistoryLines = (typeof TERMINAL_HISTORY_LINE_OPTIONS)[number];
