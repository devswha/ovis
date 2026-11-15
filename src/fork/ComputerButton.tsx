import { Monitor } from "lucide-react";
import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";

/** The same entry point in a PC's header or the lone PC's workspace list. */
export function ComputerButton({ name, open, online, row = false, onClick }: { name: string; open: boolean; online: boolean; row?: boolean; onClick: () => void }) {
  const { settings } = useSettings();
  const t = useT();
  if (!settings.computerView) return null;
  return <button type="button" className={`${row ? "machine-screen-row" : "sidebar-row-action"} machine-screen`} disabled={!online} aria-pressed={open}
    aria-label={t(open ? "Close {name}'s screen" : "Open {name}'s screen", { name })} title={t(open ? "Close screen" : "Open screen")} onClick={onClick}>
    {row ? <><span className="sidebar-mark" aria-hidden="true"><Monitor /></span><span className="machine-new-row-label">{t(open ? "Close screen" : "Open screen")}</span></> : <Monitor aria-hidden="true" />}
  </button>;
}
