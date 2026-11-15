import { describe, expect, test } from "bun:test";
import type { TelemetryCountsChange, TelemetryStatus } from "../../shared/telemetry.ts";
import { createUsageCounters } from "./usageCounters.ts";

const status = (overrides: Partial<TelemetryStatus> = {}) => ({ enabled: true, blocked_by_env: false, notice_seen: true, ...overrides }) as TelemetryStatus;

function setup(answer: TelemetryStatus | null = status(), on = true) {
  const sent: { counts: TelemetryCountsChange; keepalive: boolean }[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const clock = { now: Date.parse("2026-11-15T10:00:00Z"), narrow: false };
  let asked = 0;
  let reply: TelemetryStatus | null = answer;
  const counters = createUsageCounters({
    on,
    send: async (counts, keepalive) => { sent.push({ counts, keepalive }); return reply; },
    status: async () => { asked += 1; return reply; },
    narrow: () => clock.narrow,
    now: () => clock.now,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return () => { timer.cleared = true; }; },
  });
  const fire = () => {
    const timer = timers.filter((candidate) => !candidate.cleared).at(-1);
    if (!timer) throw new Error("no flush was armed");
    timer.cleared = true;
    timer.fn();
  };
  const armed = () => timers.filter((timer) => !timer.cleared).length;
  return { counters, sent, clock, fire, armed, asked: () => asked, answer: (next: TelemetryStatus | null) => { reply = next; } };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("usage counters", () => {
  test("a build whose notice does not say so counts nothing and asks nothing", async () => {
    const { counters, sent, armed, asked } = setup(status(), false);
    counters.heard(status());
    counters.count("chat_send");
    counters.shown("composer");
    counters.viewSwitch("terminal", "claude", "header", "local");
    counters.flush(true);
    await settle();
    expect([sent, armed(), asked()]).toEqual([[], 0, 0]);
  });

  test("nothing is kept before the server's word is heard, and the first use asks for it once", async () => {
    const { counters, sent, armed, asked } = setup();
    counters.count("chat_send");
    counters.count("chat_send");
    expect(asked()).toBe(1);
    expect(armed()).toBe(0);
    await settle();
    counters.flush(false);
    await settle();
    expect(sent).toEqual([]);
  });

  test("a heard yes counts per width, and one batch per width goes after FLUSH_MS", async () => {
    const { counters, sent, clock, fire } = setup();
    counters.heard(status());
    counters.count("chat_send");
    counters.count("chat_send");
    clock.narrow = true;
    counters.count("composer_voice");
    fire();
    await settle();
    expect(sent).toEqual([
      { counts: { width: "narrow", add: { composer_voice: 1 }, shown: [] }, keepalive: false },
      { counts: { width: "wide", add: { chat_send: 2 }, shown: [] }, keepalive: false },
    ]);
    // told: the next flush has nothing to tell
    counters.flush(true);
    await settle();
    expect(sent).toHaveLength(2);
  });

  test("a page going away tells what it has with keepalive", async () => {
    const { counters, sent } = setup();
    counters.heard(status());
    counters.count("composer_attach");
    counters.flush(true);
    await settle();
    expect(sent).toEqual([{ counts: { width: "wide", add: { composer_attach: 1 }, shown: [] }, keepalive: true }]);
  });

  test("no counting while the server is off, blocked or its notice is unseen, and a no in an answer drops the batch", async () => {
    for (const no of [status({ enabled: false }), status({ blocked_by_env: true }), status({ notice_seen: false }), null]) {
      const { counters, sent } = setup();
      counters.heard(no);
      counters.count("chat_send");
      counters.shown("composer");
      counters.flush(false);
      await settle();
      expect(sent).toEqual([]);
    }
    const { counters, sent, answer } = setup();
    counters.heard(status());
    counters.count("chat_send");
    // the server answers this batch that it was turned off meanwhile: what is counted after is not kept
    answer(status({ enabled: false }));
    counters.flush(false);
    await settle();
    counters.count("chat_send");
    counters.flush(false);
    await settle();
    expect(sent).toHaveLength(1);
  });

  test("a batch waiting when the counts are turned off is dropped, even if they are turned on again before it goes", async () => {
    const { counters, sent } = setup();
    counters.heard(status());
    counters.count("chat_send");
    counters.shown("composer");
    counters.heard(status({ enabled: false }));
    counters.heard(status());
    counters.flush(false);
    await settle();
    expect(sent).toEqual([]);
  });

  test("a control is told as shown once a day per width", async () => {
    const { counters, sent, clock } = setup();
    counters.heard(status());
    counters.shown("composer");
    counters.shown("composer");
    clock.narrow = true;
    counters.shown("composer");
    counters.flush(false);
    await settle();
    counters.shown("composer");
    clock.narrow = false;
    clock.now += 86_400_000;
    counters.shown("composer");
    counters.flush(false);
    await settle();
    expect(sent.map(({ counts }) => [counts.width, counts.shown])).toEqual([
      ["narrow", ["composer"]], ["wide", ["composer"]], ["wide", ["composer"]],
    ]);
  });

  test("a switch is counted under the pane's kind and where it was asked, never for another PC or by the app itself", async () => {
    const { counters, sent } = setup();
    counters.heard(status());
    counters.viewSwitch("terminal", "claude", "header", "local");
    counters.viewSwitch("chat", undefined, "shortcut", "local");
    counters.viewSwitch("terminal", "cursor", "palette", "local");
    counters.viewSwitch("terminal", "claude", null, "local");
    counters.viewSwitch("terminal", "claude", "header", "studio-mac");
    counters.paneUse("chat_send", "studio-mac");
    counters.paneUse("chat_send", "local");
    counters.flush(false);
    await settle();
    expect(sent).toEqual([{ counts: { width: "wide", shown: [], add: {
      view_terminal_claude: 1, view_terminal_by_header: 1,
      view_chat_shell: 1, view_chat_by_shortcut: 1,
      view_terminal_other: 1, view_terminal_by_palette: 1,
      chat_send: 1,
    } }, keepalive: false }]);
  });
});
