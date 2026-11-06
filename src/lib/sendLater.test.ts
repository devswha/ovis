import { expect, it } from "bun:test";
import type { UsageWindow } from "../../shared/protocol.ts";
import { localInputValue, parseLocalInput, planResetTime, quickTimes, scheduledStatus, shownInPane } from "./sendLater.ts";

const t = (text: string, vars?: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name]));
const window = (kind: "session" | "week", used: number, resets: string | null) => ({ kind, scope: null, used_percent: used, resets_at: resets }) as unknown as UsageWindow;

it("reads back the local time a datetime-local field shows, and refuses a date that does not exist", () => {
  const at = new Date(2026, 10, 5, 23, 7);
  expect(localInputValue(at)).toBe("2026-11-05T23:07");
  expect(parseLocalInput("2026-11-05T23:07")?.getTime()).toBe(at.getTime());
  expect(parseLocalInput("2026-02-30T09:00")).toBeNull();
  expect(parseLocalInput("")).toBeNull();
});

it("offers an hour from now to the minute, and tomorrow at 9:00 across a month's end", () => {
  const { inHour, tomorrowMorning } = quickTimes(new Date(2026, 10, 30, 22, 15, 42));
  expect(localInputValue(inHour)).toBe("2026-11-30T23:15");
  expect(inHour.getSeconds()).toBe(0);
  expect(localInputValue(tomorrowMorning)).toBe("2026-12-01T09:00");
});

it("sends a minute after the reset of the window used the most, of those still ahead", () => {
  const now = Date.parse("2026-11-05T10:00:00Z");
  expect(planResetTime([window("session", 97, "2026-11-05T12:00:00Z"), window("week", 40, "2026-11-09T00:00:00Z")], now)?.toISOString()).toBe("2026-11-05T12:01:00.000Z");
  expect(planResetTime([window("session", 20, "2026-11-05T09:00:00Z"), window("week", 40, "2026-11-09T00:00:00Z")], now)?.toISOString()).toBe("2026-11-09T00:01:00.000Z");
  expect(planResetTime([window("session", 97, null)], now)).toBeNull();
});

it("says why a due message has not gone, and why a held one will not", () => {
  const now = new Date("2026-11-05T10:00:00Z");
  const due = { state: "scheduled" as const, send_at: "2026-11-05T09:00:00Z" };
  expect(scheduledStatus({ ...due, error: { code: "pending_wait", message: "" } }, now, t)).toBe("Due · waits for the agent's turn to end");
  expect(scheduledStatus({ ...due, error: { code: "input_draft", message: "" } }, now, t)).toBe("Due · waits for the terminal's input box to be empty");
  expect(scheduledStatus({ ...due, state: "held", error: { code: "pending_target_changed", message: "" } }, now, t)).toBe("Not sent: the pane now runs another agent session");
  expect(scheduledStatus({ ...due, state: "held", error: { code: "pane_not_found", message: "" } }, now, t)).toBe("Not sent: the pane is gone");
  expect(scheduledStatus({ ...due, state: "held", error: { code: "needs_ok_restart", message: "" } }, now, t)).toStartWith("Needs your OK");
  expect(scheduledStatus({ ...due, state: "held", error: { code: "needs_ok", message: "" } }, now, t)).toStartWith("Needs your OK");
  expect(scheduledStatus({ ...due, state: "held", error: { code: "needs_ok_moved", message: "" } }, now, t)).toStartWith("Needs your OK");
  expect(scheduledStatus({ ...due, error: { code: "input_not_ready", message: "" } }, now, t)).toBe("Due · waits for a device to open this pane");
  expect(scheduledStatus({ ...due, error: { code: "awaiting_status", message: "" } }, now, t)).toBe("Due · waits for the agent's next turn after this PC's server restarted");
  expect(scheduledStatus({ state: "scheduled", send_at: "2026-11-05T12:00:00Z" }, now, t)).toStartWith("Sends ");
});

it("lists a pane's own messages, and in every pane those whose pane is gone, an uncertain one included (#2951)", () => {
  expect(shownInPane({ pane_id: "a" }, "a")).toBe(true);
  expect(shownInPane({ pane_id: "b" }, "a")).toBe(false);
  expect(shownInPane({ pane_id: "b", error: { code: "pane_not_found", message: "" } }, "a")).toBe(true);
  expect(shownInPane({ pane_id: "b", error: { code: "pane_not_found", message: "" } }, "a")).toBe(true);
});
