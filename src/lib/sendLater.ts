/**
 * The times Send later offers and the words a scheduled message's row says (#2919). Times are the browser's local
 * time; the PC keeps each as an exact instant, so a PC in another time zone sends it at the same moment.
 */
import type { ScheduledMessage, UsageWindow } from "../../shared/protocol.ts";

type T = (text: string, vars?: Record<string, string | number>) => string;

const pad = (value: number): string => String(value).padStart(2, "0");

/** A `<input type="datetime-local">` value for `date`, in local time, to the minute. */
export function localInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The instant a `datetime-local` value names in local time; null for an empty or broken one. */
export function parseLocalInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as [number, number, number, number, number, number];
  const date = new Date(year, month - 1, day, hour, minute);
  return date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/** One hour from now, and tomorrow at 9:00, both to the minute. */
export function quickTimes(now: Date): { inHour: Date; tomorrowMorning: Date } {
  const inHour = new Date(now.getTime() + 60 * 60 * 1000);
  inHour.setSeconds(0, 0);
  const tomorrowMorning = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0);
  return { inHour, tomorrowMorning };
}

/**
 * When the plan limit the pane's agent is closest to resets: the window used the most, among those that report a
 * reset still ahead, plus a minute so the limit has lifted when the message goes. Null when none reports one.
 */
export function planResetTime(windows: readonly UsageWindow[], now: number): Date | null {
  const ahead = windows.filter((window) => window.resets_at !== null && Date.parse(window.resets_at) > now);
  if (ahead.length === 0) return null;
  const limiting = ahead.reduce((most, window) => window.used_percent > most.used_percent ? window : most);
  return new Date(Date.parse(limiting.resets_at!) + 60_000);
}

/** The time a row shows: the clock alone today, with the day otherwise. */
export function sendTimeLabel(sendAt: string, now: Date): string {
  const at = new Date(sendAt);
  const today = at.toDateString() === now.toDateString();
  return at.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Whether a pane's list shows the message: its own, and in every pane one whose pane is gone, to read or discard (#2951). */
export function shownInPane(message: Pick<ScheduledMessage, "pane_id" | "error">, paneId: string | null): boolean {
  return message.pane_id === paneId || message.error?.code === "pane_not_found";
}

/** What a scheduled message's row says of it. */
export function scheduledStatus(message: Pick<ScheduledMessage, "state" | "send_at" | "error">, now: Date, t: T): string {
  if (message.state === "sending") return t("Sending…");
  if (message.state === "uncertain") return t("Not confirmed. Check the terminal before sending again.");
  const code = message.error?.code;
  if (message.state === "held") {
    if (code === "pane_not_found") return t("Not sent: the pane is gone");
    if (code === "pending_target_changed") return t("Not sent: the pane now runs another agent session");
    if (code === "needs_ok") return t("Needs your OK: a message to this pane may still be in its input line. Check the terminal first.");
    if (code === "needs_ok_moved") return t("Needs your OK: the pane moved since it was scheduled");
    if (code === "needs_ok_restart") return t("Needs your OK: it came due while this PC's server was not running");
    if (code === "device_revoked") return t("Not sent: the device that scheduled it can no longer send here");
    return t("Not sent: {reason}", { reason: message.error?.message ?? "" });
  }
  if (Date.parse(message.send_at) > now.getTime() || code === undefined) return t("Sends {time}", { time: sendTimeLabel(message.send_at, now) });
  if (code === "pending_wait") return t("Due · waits for the agent's turn to end");
  if (code === "input_draft") return t("Due · waits for the terminal's input box to be empty");
  if (code === "agent_blocked") return t("Due · waits for an answer in the terminal");
  if (code === "input_not_ready") return t("Due · waits for a device to open this pane");
  if (code === "awaiting_status") return t("Due · waits for the agent's next turn after this PC's server restarted");
  return t("Due · waits to send: {reason}", { reason: message.error?.message ?? "" });
}
