/**
 * The inbox mode's rail (from 769px): one narrow column of icon buttons at the far left of the mode's column, before
 * its list, holding the mode's ways out and around. It is a part of the column (App.tsx), cut out of the sidebar's
 * width (InboxMode.css), so the pane beside the column is where the classic shell has it. A window under 769px
 * draws no rail: its list keeps its own controls.
 */
import { useT } from "../lib/i18n.ts";
import { OvisMark } from "./OvisMark.tsx";
import "./InboxRail.css";

export interface InboxRailProps {
  /** out of the mode, to the classic app on the pane of the open thread: the mark at the rail's top */
  onExit(): void;
}

export function InboxRail({ onExit }: InboxRailProps) {
  const t = useT();
  return (
    <nav className="inbox-rail" aria-label={t("Inbox mode")}>
      <div className="inbox-rail-group is-top">
        <button type="button" className="icon-button inbox-rail-item inbox-rail-exit" aria-label={t("Back to Ovis")} title={t("Back to Ovis")} onClick={onExit}>
          <OvisMark width="22" height="22" className="inbox-rail-mark" />
        </button>
      </div>
    </nav>
  );
}

/** The rail's surface at its width, with no control: what the mode's shell draws before anything answers. */
export function InboxRailBlank() {
  return <div className="inbox-rail" />;
}
