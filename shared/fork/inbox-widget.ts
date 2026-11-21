import type { Friend } from "../friends.ts";

/** POST: `{ subscription, placed }` from the phone app, which holds that subscription's keys. */
export const INBOX_WIDGET_PATH = "/api/fork/inbox-widget";

/** One agent on the home-screen widget, in the inbox's order. */
export interface InboxWidgetRow {
  /** pane id */
  p: string;
  /** machine id, absent for this PC */
  m?: string;
  /** workspace id, when known */
  w?: string;
  /** name */
  n: string;
  f?: Friend;
  /** b waiting on you, d finished, w working, i idle */
  s: "b" | "d" | "w" | "i";
  /** since when, in seconds since the epoch */
  t: number;
  /** its last words, as the inbox row shows them, cut short */
  d?: string;
}

/**
 * What a quiet push to a placed widget carries (shared/push.ts PushPayload `inbox`): the phone app
 * (app/android/ovis-widget) draws it and never shows it as a notification.
 */
export interface InboxDigest {
  /** when the PC sent it, in seconds since the epoch: the widget greys a PC it has not heard from */
  at: number;
  /** the subscription it went to, so a tap opens the PC that sent it (as an alert's `endpoint`) */
  endpoint: string;
  server_id?: string;
  rows: InboxWidgetRow[];
  /** agents left out to fit one push */
  more: number;
}
