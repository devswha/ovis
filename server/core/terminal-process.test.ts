import { describe, expect, it } from "bun:test";
import { attachScreenStarted } from "./terminal-process.ts";

// herdr 0.9.5 `terminal attach`, captured through the Rust PTY host with its two startup queries
// taken out (AttachStartupProbes): the setup, then a screen or a refusal's teardown and line
const MOUSE_OFF = "\x1b[?1006l\x1b[?1016l\x1b[?1015l\x1b[?1005l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?9l";
const SETUP = `${MOUSE_OFF}\x1b[?1049h${MOUSE_OFF}\x1b[?2031l${MOUSE_OFF}\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h\x1b[?2004h\x1b[?7l`;
const TEARDOWN = `\x1b[?7h\x1b[?1004l\x1b[?2004l${MOUSE_OFF}\x1b[?1006l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1049l\x1b[?25h\x1b[0 q`;
const REFUSALS = [
  "herdr: server shut down: terminal attach failed: terminal term_0 already has an attached client; retry with --takeover\r\n",
  "herdr: server shut down: terminal attach failed: terminal term_0 has a read in progress; retry\r\n",
];
const SCREEN = "\x1b[?2026h\x1b[?25l\x1b]8;;\x1b\\\x1b[2J\x1b[1;1H\x1b[0;39;49mbash-5.3$ echo PROBE-READY";

describe("attachScreenStarted", () => {
  it("never takes any part of a refusal for a screen, at whatever byte its reads end", () => {
    for (const line of REFUSALS) {
      const output = SETUP + TEARDOWN + line;
      for (let end = 0; end <= output.length; end++) expect([end, attachScreenStarted(output.slice(0, end))]).toEqual([end, false]);
    }
    // the words of a takeover's diagnostic without herdr's prefix
    expect(attachScreenStarted("terminal attach taken over\r\n")).toBe(false);
  });
  it("takes a screen as soon as its first byte past the setup that no mode set has comes", () => {
    expect(attachScreenStarted(SETUP)).toBe(false);
    // a lone ESC may still start a mode set; `ESC ]` (its hyperlink reset) is the screen's
    const first = SETUP.length + SCREEN.indexOf("\x1b]");
    expect(attachScreenStarted((SETUP + SCREEN).slice(0, first + 1))).toBe(false);
    for (let end = first + 2; end <= SETUP.length + SCREEN.length; end++) expect([end, attachScreenStarted((SETUP + SCREEN).slice(0, end))]).toEqual([end, true]);
    // a screen whose first text is not a refusal's start
    expect(attachScreenStarted(`${SETUP}pane text: has a read in progress; retry\r\n`)).toBe(true);
  });
});
