/**
 * The inbox mode's rail (from 769px): one narrow column of icon buttons at the far left of the mode's column, before
 * its list, holding the mode's ways out and around. It is a part of the column (App.tsx), cut out of the sidebar's
 * width (InboxMode.css), so the pane beside the column is where the classic shell has it. A window under 769px
 * draws no rail: its list keeps its own controls.
 *
 * At its top: the way out, the mode's one place and the command palette. Pushed to its foot: the agents that wait,
 * this device's alerts and Settings. A button says what it is in its name and its tooltip; no label is drawn.
 */
import { Bell, BellOff, CircleHelp, Inbox, Search, Settings } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { OvisMark } from "./OvisMark.tsx";
import "./InboxRail.css";

export interface InboxRailProps {
  /** out of the mode, to the classic app on the pane of the open thread: the mark at the rail's top */
  onExit(): void;
  /** to the list's top, with the keyboard's focus on the list: the mode's one place, which is always the current one */
  onInbox(): void;
  onPalette(): void;
  /** the agents that wait other than the open thread's, and the press that opens the next of them; null while none waits */
  waiting: { count: number; open(): void } | null;
  /** this device's alerts (lib/alertsBell.ts): whether they are on, the sentence that says how, and the press that switches them */
  alerts: { on: boolean; title: string; toggle(): void };
  onSettings(): void;
  /** a tooltip with its shortcut's keys after it, where one is set (App.tsx) */
  shortcutTitle(label: string, id: "palette" | "settings"): string;
}

export function InboxRail({ onExit, onInbox, onPalette, waiting, alerts, onSettings, shortcutTitle }: InboxRailProps) {
  const t = useT();
  const AlertsGlyph = alerts.on ? Bell : BellOff;
  return (
    <nav className="inbox-rail" aria-label={t("Inbox mode")}>
      <div className="inbox-rail-group is-top">
        <button type="button" className="icon-button inbox-rail-item inbox-rail-exit" aria-label={t("Back to Ovis")} title={t("Back to Ovis")} onClick={onExit}>
          <OvisMark width="22" height="22" className="inbox-rail-mark" />
        </button>
        <button type="button" className="icon-button inbox-rail-item inbox-rail-place" aria-label={t("Agent inbox")} title={t("Agent inbox")} aria-current="page" onClick={onInbox}>
          <Inbox aria-hidden="true" />
        </button>
        <button type="button" className="icon-button inbox-rail-item inbox-rail-palette" aria-label={t("Search panes and actions")} title={shortcutTitle(t("Search panes and actions"), "palette")} onClick={onPalette}>
          <Search aria-hidden="true" />
        </button>
      </div>
      <div className="inbox-rail-group is-lower">
        {/* the first of the lower group, so nothing under it moves when it comes or goes; the pill is the app's own
            waiting pill, which says nothing to a screen reader: the button's name says the number */}
        {waiting !== null && (
          <button type="button" className="icon-button inbox-rail-item inbox-rail-waiting" aria-label={t("{count} waiting for you", { count: waiting.count })} title={t("Open the next session waiting for you")} onClick={waiting.open}>
            <CircleHelp aria-hidden="true" />
            <span className="header-more-dot is-waiting" data-count={waiting.count} aria-hidden="true" />
          </button>
        )}
        {/* off is another glyph, not a colour: the switch says its state by shape, and to a screen reader as pressed */}
        <button type="button" className="icon-button inbox-rail-item inbox-rail-alerts" aria-label={t("Alerts")} title={alerts.title} aria-pressed={alerts.on} onClick={alerts.toggle}>
          <AlertsGlyph aria-hidden="true" />
        </button>
        <button type="button" className="icon-button inbox-rail-item inbox-rail-settings" aria-label={t("Settings")} title={shortcutTitle(t("Settings"), "settings")} onClick={onSettings}>
          <Settings aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}

/** The rail's surface at its width, with no control: what the mode's shell draws before anything answers. */
export function InboxRailBlank() {
  return <div className="inbox-rail" />;
}
