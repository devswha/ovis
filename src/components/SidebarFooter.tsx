import type { ReactNode } from "react";
import { Settings } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { UsageMeters } from "./UsageMeters.tsx";

/**
 * The navigation column's foot: what the caller puts first (a setup row, the agent inbox's entry), then one row on
 * the sidebar's grid with the Settings gear and the plan meters. Its sizes are its own (Sidebar.css), so it is the
 * same foot wherever a column ends in it.
 */
export function SidebarFooter({ start, afterSettings, watching = false, onSettings, onUsageLogin }: {
  start?: ReactNode;
  /** drawn beside the gear (upstream's Inbox entry) */
  afterSettings?: ReactNode;
  watching?: boolean;
  onSettings(): void;
  /** a sign-in tab the usage popover opened; a watching device has none */
  onUsageLogin(paneId: string): void;
}) {
  const t = useT();
  return <footer className="sidebar-footer">
    {start}
    {/* no Install app here: a page knows it is installed only in the app's own window, so a row kept
        showing in every tab. */}
    <div className="sidebar-footer-row">
      <button className="btn btn-ghost sidebar-footer-action sidebar-footer-settings" aria-label={t("Settings")} title={t("Settings (⌘⇧,)")} onClick={onSettings}><Settings aria-hidden="true" /></button>
      {afterSettings}
      <UsageMeters watching={watching} onLocalLogin={watching ? undefined : onUsageLogin} />
    </div>
  </footer>;
}
