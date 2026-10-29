import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { liveTurnShown, nextLiveTurnArm, TerminalFallback, turnOnlyInTerminal, type LiveTurnArm } from "./ChatView.tsx";

const render = (live: boolean): string => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(TerminalFallback, { paneId: "w1:p1", visible: true, live }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

/** Renders of one pane: each step is what ChatView holds then, and whether the box shows. */
function run(steps: { running: boolean; started: number; settled: number | null; written: string }[]): boolean[] {
  let arm: LiveTurnArm | null = null;
  return steps.map(({ running, started, settled, written }) => {
    arm = nextLiveTurnArm(arm, "w1:p1", running, started, settled === null ? null : { pane: "w1:p1", read: settled }, written);
    return running && liveTurnShown(arm, written);
  });
}

describe("a Letta turn still running", () => {
  it("is in the terminal only while Letta works or waits on the user: its transcript gets the turn when it ends", () => {
    expect(turnOnlyInTerminal("letta-transcript", "working")).toBe(true);
    expect(turnOnlyInTerminal("letta-transcript", "blocked")).toBe(true);
    expect(turnOnlyInTerminal("letta-transcript", "idle")).toBe(false);
    expect(turnOnlyInTerminal("letta-transcript", "done")).toBe(false);
    expect(turnOnlyInTerminal("letta-transcript", undefined)).toBe(false);
    expect(turnOnlyInTerminal("omo-transcript", "working")).toBe(false);
    expect(turnOnlyInTerminal("claude-transcript", "working")).toBe(false);
    expect(turnOnlyInTerminal(undefined, "working")).toBe(false);
  });

  it("goes in the render that adds the written turn, before the pane's status follows", () => {
    expect(run([
      { running: true, started: 3, settled: 3, written: "4" },
      { running: true, started: 4, settled: 4, written: "4" },
      { running: true, started: 5, settled: 5, written: "6" },
      { running: false, started: 5, settled: 5, written: "6" },
    ])).toEqual([true, true, false, false]);
  });

  it("stays for the running turn when the transcript shown first was older: a cached answer, or a page that was hidden", () => {
    expect(run([
      { running: true, started: 0, settled: null, written: "2" },
      { running: true, started: 1, settled: 1, written: "4" },
      { running: true, started: 2, settled: 2, written: "4" },
      { running: true, started: 3, settled: 3, written: "6" },
    ])).toEqual([true, true, true, false]);
  });

  it("takes no baseline from a read that started before the turn ran", () => {
    expect(run([
      { running: true, started: 7, settled: 6, written: "4" },
      { running: true, started: 8, settled: 7, written: "6" },
      { running: true, started: 8, settled: 8, written: "6" },
      { running: true, started: 9, settled: 9, written: "8" },
    ])).toEqual([true, true, true, false]);
  });

  it("arms afresh after the chat was hidden or offline, when a turn may have ended and the next begun unseen", () => {
    expect(run([
      { running: true, started: 2, settled: 2, written: "4" },
      { running: true, started: 3, settled: 3, written: "4" },
      { running: false, started: 3, settled: 3, written: "4" },
      { running: true, started: 3, settled: 3, written: "4" },
      { running: true, started: 4, settled: 4, written: "6" },
      { running: true, started: 5, settled: 5, written: "8" },
    ])).toEqual([true, true, false, true, true, false]);
  });

  it("arms afresh for the next turn and for another pane", () => {
    let arm = nextLiveTurnArm(null, "w1:p1", true, 1, { pane: "w1:p1", read: 2 }, "4");
    arm = nextLiveTurnArm(arm, "w1:p1", true, 2, { pane: "w1:p1", read: 2 }, "4");
    expect(arm?.key).toBe("4");
    expect(nextLiveTurnArm(arm, "w1:p2", true, 2, { pane: "w1:p1", read: 2 }, "9")).toEqual({ pane: "w1:p2", after: 2, key: null });
    expect(nextLiveTurnArm(arm, "w1:p1", false, 2, { pane: "w1:p1", read: 2 }, "6")).toBeNull();
  });

  it("opens under the turns with its full height from the start, out of the chat's live announcements", () => {
    const live = render(true);
    expect(live).toContain('class="chat-terminal-fallback is-live" open=""');
    expect(live).toMatch(/<pre[^>]*aria-live="off"[^>]*><\/pre>/);
    const fallback = render(false);
    expect(fallback).toContain('class="chat-terminal-fallback"');
    expect(fallback).not.toContain("open=");
    expect(fallback).not.toContain("<pre");
  });
});
