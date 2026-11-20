import { useEffect, useState } from "react";
import { t } from "../../lib/i18n.ts";
import "./ComputerView.css";

// src: the relay viewer's address, on this server or the PC's own (server/fork/screen.ts)
type Screen = { src: string } | { error: string } | null;

/**
 * The Computer view: the PC's desktop, live, over the pane's Chat or Terminal, which stay connected
 * under it. The server opens screen-here's bridge to that PC (server/fork/screen.ts) and passes on
 * its screen-relay viewer, which is shown as it is: its own toolbar has the full screen and keyboard
 * buttons, so nothing of Ovis's sits on it. `hidden` keeps it connected out of sight.
 */
export function ComputerView({ machineId, machineName, hidden }: { machineId: string; machineName: string; hidden: boolean }) {
  const [screen, setScreen] = useState<Screen>(null);

  useEffect(() => {
    let live = true;
    setScreen(null);
    void fetch("/api/screen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ machine_id: machineId }), credentials: "same-origin" })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as { path?: string; url?: string; error?: { message?: string } } | null;
        if (!live) return;
        const address = response.ok ? body?.url ?? body?.path : undefined;
        setScreen(address ? { src: address } : { error: body?.error?.message ?? t("This PC's desktop can't be shown.") });
      })
      .catch(() => { if (live) setScreen({ error: t("This PC's desktop can't be shown.") }); });
    return () => { live = false; };
  }, [machineId]);

  if (screen === null || "error" in screen) {
    return <div className={`computer-view is-message${hidden ? " is-hidden" : ""}`} role={screen ? "alert" : undefined}>{screen?.error ?? t("Connecting…")}</div>;
  }
  return (
    <div className={`computer-view${hidden ? " is-hidden" : ""}`}>
      <iframe src={screen.src} title={t("{name}'s desktop", { name: machineName })} allow="fullscreen; clipboard-read; clipboard-write" allowFullScreen />
    </div>
  );
}
