/**
 * The new-device notice of an account whose signed list this device is in (docs/account-list.md, "Putting a member
 * out"): "{device} was allowed into your account by {approver}.", from this device's own copy of the list, with Not
 * me, which asks Remove's question with everything the device added ticked. An account with no list keeps the PCs'
 * notices of an admission.
 */
import { useEffect, useState } from "react";
import { Smartphone, X } from "lucide-react";

import type { AccountList } from "../lib/account/accountList.ts";
import { inList } from "../lib/account/listLeave.ts";
import { closeStoredNotice, listNewcomers, readNoticesSeen, writeNoticesSeen } from "../lib/account/listNotices.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { useT } from "../lib/i18n.ts";
import { NotMeButton } from "./BlockOutcomes.tsx";
import { RemoveDialog, roleOf, useListView } from "./ListDevices.tsx";

export function ListDeviceNotices({ list = pageAccountList() }: { readonly list?: AccountList | null }) {
  const t = useT();
  const view = useListView(list);
  // the notices kept in the page's storage are read again after each change this page makes to them
  const [, setKept] = useState(0);
  // Not me's question, by the key and name it was asked for: it stays up when its notice goes, as after a first part of
  // its removal put the device out, to say what was done and to go on with the rest
  const [asked, setAsked] = useState<{ readonly key: string; readonly name: string } | null>(null);
  const [removed, setRemoved] = useState<readonly string[]>([]);
  // only a device that may remove anybody is told: Not me is what the notice is for
  const writer = list?.writer() ?? null;
  const account = view?.account ?? null;
  const active = list !== null && view !== null && account !== null && writer !== null && inList(view, account) ? { list, view, account, writer } : null;
  const seen = active === null ? null : readNoticesSeen(active.account, active.writer.list, active.writer.keys.key);
  const firstLook = active !== null && seen === null;
  const footing = active?.writer.state.footing.seq ?? null;
  useEffect(() => {
    if (!firstLook || active === null || footing === null) return;
    writeNoticesSeen(active.account, { list: active.writer.list, member: active.writer.keys.key, floor: footing, closed: [] });
    setKept((count) => count + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per first look at a list, by its place
  }, [firstLook, account, active?.writer.list, active?.writer.keys.key, footing]);

  const close = (key: string, shown: ReturnType<typeof listNewcomers>): void => {
    if (active === null) return;
    closeStoredNotice(active.account, active.writer.list, active.writer.keys.key, shown, key);
    setKept((count) => count + 1);
  };
  const removedLines = removed.map((name, index) => (
    <div key={`removed-${index}`} className="update-notice is-paired device-notice" role="status" data-testid="list-device-notice-removed">
      <Smartphone aria-hidden="true" />
      <span className="device-notice-text"><span>{t("{name} was removed from your account.", { name })}</span></span>
      <div className="device-paired-actions">
        <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => setRemoved((now) => now.filter((_, at) => at !== index))}><X /></button>
      </div>
    </div>
  ));
  if (active === null) return <>{removedLines}</>;
  const shown = listNewcomers(active.writer.state, active.writer.keys.key, seen);
  const nameOf = (key: string | null): string => {
    if (key === null) return t("Unknown key");
    const device = active.view.devices.find((row) => row.key === key);
    if (device !== undefined) return device.name?.label ?? t("Unnamed device");
    const endpoint = active.list.pcOfKey(key);
    if (endpoint !== null) return active.view.pcs.find((pc) => pc.endpoint === endpoint)?.name?.label ?? t("Unnamed PC");
    return t("Unknown key");
  };
  return <>
    {removedLines}
    {shown.map((newcomer) => {
      const device = active.view.devices.find((row) => row.key === newcomer.key);
      const name = nameOf(newcomer.key);
      const role = device === undefined ? null : roleOf(t, device);
      return (
        <div key={newcomer.key} className="update-notice is-paired device-notice" role="status" data-testid="list-device-notice">
          <Smartphone aria-hidden="true" />
          <span className="device-notice-text">
            <span>{t("{device} was allowed into your account by {approver}.", { device: name, approver: nameOf(newcomer.by) })}</span>
            {role !== null && <span className="settings-hint">{role}</span>}
          </span>
          <div className="device-paired-actions">
            <NotMeButton sending={asked?.key === newcomer.key} onPress={() => setAsked({ key: newcomer.key, name })} />
            <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => close(newcomer.key, shown)}><X /></button>
          </div>
        </div>
      );
    })}
    {asked !== null && (
      <RemoveDialog list={active.list} view={active.view} removing={asked.key} name={asked.name} ticked
        onClose={() => setAsked(null)} onRemoved={(gone) => { setAsked(null); close(asked.key, shown); setRemoved((now) => [...now, gone]); }} />
    )}
  </>;
}
