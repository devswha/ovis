import "./ShellPcs.css";

import { useCallback, useEffect, useState } from "react";
import { Monitor } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { serverIdOfPath, serverScopePath } from "../lib/shellMode.ts";
import type { PcFinding } from "../lib/relay/pcStatus.ts";

interface ShellPc { readonly server_id: string; readonly name: string | null; readonly found: PcFinding | "checking" }

/**
 * The other PCs this device is paired with, for the hosted app's sidebar: each opens on its own page,
 * which connects with the key this device holds for it, as a tap on it in the front page's list did. Each is checked
 * once when the list is drawn (`on`: only the hosted app on a PC's page has such a list) (pcStatus.ts, a probe that stops before signing in); one that does not answer says so,
 * with a way to check it again.
 */
export function useShellPcs(on: boolean): { readonly pcs: readonly ShellPc[]; readonly recheck: (serverId: string) => void } {
  const [pcs, setPcs] = useState<readonly ShellPc[]>([]);
  const here = serverIdOfPath(window.location.pathname);
  const check = useCallback(async (serverId: string): Promise<void> => {
    setPcs((rows) => rows.map((row) => row.server_id === serverId ? { ...row, found: "checking" } : row));
    const [{ indexedDeviceStore }, { checkPc }] = await Promise.all([import("../lib/relay/device.ts"), import("../lib/relay/pcStatus.ts")]);
    const device = await indexedDeviceStore.get(serverId);
    const found: PcFinding = device === undefined ? { kind: "offline", reason: "pc" }
      : await checkPc(device, { relay: (url) => new WebSocket(url) }).catch((): PcFinding => ({ kind: "offline", reason: "relay" }));
    setPcs((rows) => rows.map((row) => row.server_id === serverId ? { ...row, found } : row));
  }, []);
  useEffect(() => {
    if (!on) return;
    let gone = false;
    void import("../lib/relay/device.ts").then(({ indexedDeviceStore }) => indexedDeviceStore.list()).then((devices) => {
      if (gone) return;
      const others = devices.filter((device) => device.server_id !== here && device.device_id !== null);
      setPcs(others.map((device) => ({ server_id: device.server_id, name: device.name ?? null, found: "checking" })));
      for (const device of others) void check(device.server_id);
    }, (error: unknown) => { console.warn("Ovis: this device's other PCs could not be read", error); });
    return () => { gone = true; };
  }, [on, here, check]);
  return { pcs, recheck: (serverId) => void check(serverId) };
}

/** The rows: a PC that answers opens on a tap; one that does not reads Off, with Check again. */
export function ShellPcs({ pcs, recheck }: ReturnType<typeof useShellPcs>) {
  const t = useT();
  if (pcs.length === 0) return null;
  return (
    <ul className="shell-pcs" aria-label={t("Other PCs")}>
      {pcs.map((pc) => {
        const off = pc.found !== "checking" && pc.found.kind === "offline";
        const name = pc.name ?? t("Unnamed PC");
        return (
          <li key={pc.server_id} className="shell-pc" data-pc-state={pc.found === "checking" ? "checking" : off ? "off" : "on"}>
            <a className="shell-pc-open" href={serverScopePath(pc.server_id)}>
              <Monitor aria-hidden="true" />
              <span className="shell-pc-name">{name}</span>
              {!off && pc.found !== "checking" && <span className="status-dot" data-state="connected" aria-label={t("Connected")} />}
            </a>
            {off && (
              <span className="shell-pc-off">
                <span>{t("Off|pc state")}</span>
                <span aria-hidden="true">·</span>
                <button type="button" className="btn shell-pc-check" onClick={() => recheck(pc.server_id)}>{t("Check again")}</button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
