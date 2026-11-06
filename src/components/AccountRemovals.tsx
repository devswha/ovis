import { useCallback, useEffect, useState } from "react";

import { useT } from "../lib/i18n.ts";
import { clearable, clearSettled, settledEverywhere, unsettledPcs, type ForeignRemoval, type PcRemovalState, type TrackedRemoval } from "../lib/account/removals.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { indexedDeviceStore } from "../lib/relay/device.ts";


/**
 * The removals this device signed and what each PC of their list last said (docs/account.md,
 * "Removing a device"). `version` changes when a removal was just made, so the list is read again.
 * `foreign`: what the PC in view says other devices removed or keeps out, offered to remove everywhere.
 */
export function AccountRemovals({ account, version, foreign, onRemoveEverywhere }: {
  account: string; version: number; foreign: readonly ForeignRemoval[]; onRemoveEverywhere: (key: string, label: string) => void;
}) {
  const t = useT();
  const stateText = (state: PcRemovalState): string => {
    switch (state) {
      case "reported": return t("removed");
      case "repaired": return t("paired again there");
      case "waiting": return t("waiting for its signer there");
      case "unconfirmed": return t("update Ovis there to confirm");
      case "unknown": return t("could not confirm");
      case "not-reached": return t("not reached yet");
    }
  };
  const [tracked, setTracked] = useState<TrackedRemoval[]>([]);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [clearing, setClearing] = useState(false);
  const read = useCallback(async () => {
    const all = Object.values(await indexedAccountStore.get("tracked") ?? {}).filter((entry) => entry.account === account);
    setTracked(all.sort((a, b) => a.record.issued_at < b.record.issued_at ? 1 : -1));
    setNames(new Map((await indexedDeviceStore.list()).map((device) => [device.server_id, device.name ?? device.server_id.slice(0, 8)])));
  }, [account]);
  useEffect(() => { void read().catch(() => undefined); }, [read, version]);
  const [confirming, setConfirming] = useState<string | null>(null);
  if (tracked.length === 0 && foreign.length === 0) return null;
  const pcName = (id: string) => names.get(id) ?? id.slice(0, 8);
  const settled = tracked.filter(clearable);
  const clear = async () => {
    if (!clearing) { setClearing(true); return; }
    setClearing(false);
    await clearSettled(indexedAccountStore, account);
    await read();
  };
  return (
    <section className="devices-removals" aria-label={t("Removed devices")}>
      <h4 className="settings-label">{t("Removed devices")}</h4>
      <ul className="devices-list">
        {tracked.map((entry) => {
          const open = unsettledPcs(entry);
          return (
            <li key={entry.record.id} className="devices-row">
              <div className="devices-name">
                <span className="settings-label">{entry.label ?? t("A device")}</span>
                <span className="settings-description">{settledEverywhere(entry)
                  ? t("Settled on every PC this device knows")
                  : open.length === 0 ? t("Your account's PC list was not read yet")
                  : t("Not confirmed on {n} PCs: {pcs}", { n: String(open.length), pcs: open.map((id) => `${pcName(id)} (${stateText(entry.pcs[id]!.state)})`).join(", ") })}</span>
                {Object.entries(entry.pcs).some(([, report]) => report.state === "repaired") && (
                  <span className="settings-description">{t("Paired again on: {pcs}", { pcs: Object.entries(entry.pcs).filter(([, report]) => report.state === "repaired").map(([id]) => pcName(id)).join(", ") })}</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {foreign.length > 0 && (
        <ul className="devices-list" aria-label={t("Removed or kept out by another device")}>
          {foreign.map((entry) => {
            const label = t("A device ({key})", { key: entry.key.slice(-8) });
            return (
              <li key={entry.key} className="devices-row">
                <div className="devices-name">
                  <span className="settings-label">{label}</span>
                  <span className="settings-description">{t("Another device removed it on this PC. Remove it everywhere to sign the removal yourself.")}</span>
                </div>
                <div className="devices-actions">
                  <button type="button" className={confirming === entry.key ? "btn btn-danger" : "btn"} onClick={() => {
                    if (confirming !== entry.key) { setConfirming(entry.key); return; }
                    setConfirming(null);
                    onRemoveEverywhere(entry.key, label);
                  }}>{confirming === entry.key ? t("Remove everywhere?") : t("Remove everywhere")}</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {settled.length > 0 && (
        <div className="devices-actions">
          {clearing && <p className="settings-hint">{t("PCs added to the account later get these removals only from the PCs that hold them when they join.")}</p>}
          <button type="button" className={clearing ? "btn btn-danger" : "btn"} onClick={() => void clear()}>{clearing ? t("Clear settled removals?") : t("Clear settled removals")}</button>
        </div>
      )}
    </section>
  );
}
