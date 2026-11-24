/**
 * What a person is told of the move of an account that was in use onto its signed list (docs/account-list.md, "An
 * account that was in use"; Part F, F1 and F11), and nothing else: once, who made the list and every device and PC it
 * brought in, each PC with Not me; and on a device the list carried in that did not join it, why, naming the PCs that
 * said so and what to do. Nothing of the move asks the person to press anything else.
 */
import "./AccountApprovalPrompt.css";
import "./ListMoveNotice.css";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Monitor, Smartphone } from "lucide-react";
import { hexToBytes } from "@noble/hashes/utils.js";

import { deriveServerId } from "../../shared/relay-server-proof.ts";
import type { AccountList, AccountListView } from "../lib/account/accountList.ts";
import { knownPcs } from "../lib/account/knownPcs.ts";
import { removeListPc } from "../lib/account/listRemove.ts";
import { writeScope } from "../lib/account/listWrite.ts";
import type { MoveNoticeView } from "../lib/account/listMigrate.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { NotMeButton } from "./BlockOutcomes.tsx";

/** The view of `list`, redrawn as it changes. */
function useView(list: AccountList | null): AccountListView | null {
  const [view, setView] = useState<AccountListView | null>(() => list?.view() ?? null);
  useEffect(() => {
    if (list === null) return;
    setView(list.view());
    return list.subscribe(setView);
  }, [list]);
  return view;
}

/** Puts the PC at `endpoint` out of the list, for the account and list the notice was drawn for: true once the list took it. */
async function removeFromList(list: AccountList, endpoint: string): Promise<boolean> {
  const scope = writeScope(list);
  const outcome = await removeListPc(list, endpoint, scope === null ? {} : { expect: scope });
  return outcome.removed;
}

/**
 * The one-time notice, drawn where its host puts it. `removePc`: Not me's removal of a PC (the list's own by default).
 * `notMeDevice`: Not me's removal of a device, which asks Remove's question of the devices list with everything ticked
 * (`useNotMe(list).notMe` of ListDevices.tsx, whose `dialog` its host draws beside this); without it a device's row has
 * no Not me here, rather than a button that does nothing.
 */
export function ListMoveNotice({ list = pageAccountList(), removePc, notMeDevice, scrim = false }: {
  readonly list?: AccountList | null;
  /** drawn over a scrim of its own, in the page's body, as a modal is */
  readonly scrim?: boolean;
  readonly removePc?: (endpoint: string) => Promise<boolean>;
  readonly notMeDevice?: (key: string, name: string) => void;
}) {
  const t = useT();
  const view = useView(list);
  const [notice, setNotice] = useState<MoveNoticeView | null>(null);
  const [asked, setAsked] = useState<{ readonly endpoint: string; readonly name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const account = view?.account ?? null;
  const seen = async (): Promise<void> => {
    if (list === null || account === null || notice === null) return;
    await list.noticeSeen?.(account, notice.list).catch((error: unknown) => console.warn("Ovis: the notice of the move stays until it is kept as seen", error instanceof Error ? error.name : error));
    setNotice(null);
  };
  const following = view?.status.at === "following" && view.status.standing === "in";
  useEffect(() => {
    let live = true;
    if (list === null || account === null || !following || list.notice === undefined) { setNotice(null); return; }
    void list.notice(account).then((read) => { if (live) setNotice(read); }, (error: unknown) => {
      console.warn("Ovis: the notice of the move onto the account's list could not be read", error instanceof Error ? error.name : error);
    });
    return () => { live = false; };
  }, [list, account, following, view]);
  // Back answers the question that is asked first, then is the notice's OK; never while a removal is under way
  usePhoneSheetBack(() => {
    if (busy) return false;
    if (asked !== null) { setAsked(null); return false; }
    void seen();
  }, list !== null && account !== null && notice !== null);
  if (list === null || account === null || notice === null) return null;
  const deviceName = (name: MoveNoticeView["devices"][number]["name"]): string => name?.label ?? t("A device of yours");
  const pcName = (name: MoveNoticeView["pcs"][number]["name"]): string => name?.label ?? t("Unnamed PC");

  const remove = async (): Promise<void> => {
    if (asked === null) return;
    setBusy(true);
    try {
      const gone = await (removePc ?? ((endpoint: string) => removeFromList(list, endpoint)))(asked.endpoint);
      setSaid(gone ? t("{pc} was removed from your account.", { pc: asked.name }) : t("{pc} could not be removed. Try again.", { pc: asked.name }));
      if (gone) setNotice((now) => now === null ? now : { ...now, pcs: now.pcs.filter((pc) => pc.endpoint !== asked.endpoint) });
    } catch (error) {
      console.warn("Ovis: the PC was not removed from the account's list", error instanceof Error ? error.name : error);
      setSaid(t("{pc} could not be removed. Try again.", { pc: asked.name }));
    } finally {
      setBusy(false);
      setAsked(null);
    }
  };
  const title = t("Your account now keeps its own list");
  const card = (
    <div className="modal account-approval list-move-notice" role="dialog" aria-modal="true" aria-label={title} data-testid="list-move-notice">
      <h2 className="account-approval-title">{title}</h2>
      <p className="account-approval-lead">{notice.first.self ? t("This device made your account's list.") : t("{device} made your account's list.", { device: deviceName(notice.first.name) })}</p>
      {notice.devices.length + notice.pcs.length > 0 && <>
        <p className="account-approval-hint">{t("It brought these in. Press Not me on one you do not know.")}</p>
        <ul className="list-move-rows">
          {notice.devices.map((row) => (
            <li key={row.key} className="list-move-row">
              <Smartphone aria-hidden="true" />
              <span className="list-move-name">{deviceName(row.name)}</span>
              {notMeDevice !== undefined && <NotMeButton sending={false} onPress={() => notMeDevice(row.key, deviceName(row.name))} />}
            </li>
          ))}
          {notice.pcs.map((row) => (
            <li key={row.endpoint} className="list-move-row">
              <Monitor aria-hidden="true" />
              <span className="list-move-name">{pcName(row.name)}</span>
              <NotMeButton sending={busy && asked?.endpoint === row.endpoint} onPress={() => { setSaid(null); setAsked({ endpoint: row.endpoint, name: pcName(row.name) }); }} />
            </li>
          ))}
        </ul>
      </>}
      {asked !== null && (
        <div className="list-move-ask" role="alertdialog" aria-label={t("Remove {pc} from your account?", { pc: asked.name })}>
          <p className="account-approval-ask">{t("Remove {pc} from your account?", { pc: asked.name })}</p>
          <div className="account-approval-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => setAsked(null)}>{t("Cancel")}</button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>{t("Remove")}</button>
          </div>
        </div>
      )}
      {said !== null && <p className="account-approval-note" role="status">{said}</p>}
      <div className="account-approval-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void seen()}>{t("OK")}</button>
      </div>
    </div>
  );
  return scrim ? createPortal(<div className="modal-scrim">{card}</div>, document.body) : card;
}

/** A PC's name as this device last read the account's PCs, by its relay key; null where it has none. */
function knownName(account: string, endpoint: string): string | null {
  try {
    const serverId = deriveServerId(hexToBytes(endpoint));
    return knownPcs(account).find((pc) => pc.server_id === serverId)?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * On a device the list carried in, which did not join it (F5): why, naming the PCs that said so, and what to do. It
 * asks to be let in as a new device does meanwhile. A device that only waits on its PCs is told nothing.
 */
export function ListJoinRefusal({ list = pageAccountList(), pcName, scrim = false }: { readonly list?: AccountList | null; readonly pcName?: (endpoint: string) => string | null; readonly scrim?: boolean }) {
  const t = useT();
  const view = useView(list);
  const [closed, setClosed] = useState<string | null>(null);
  const status = view?.status;
  const refused = status?.at === "not_in" ? status.refused : undefined;
  const shownFor = status?.at === "not_in" && refused !== undefined ? `${status.list}:${refused.why}:${refused.pcs.join(",")}` : null;
  // Back is Close
  usePhoneSheetBack(() => { setClosed(shownFor); }, shownFor !== null && closed !== shownFor && view?.account != null);
  if (view === null || view.account === null || status === undefined || status.at !== "not_in" || status.refused === undefined || shownFor === null) return null;
  const account = view.account;
  if (closed === shownFor) return null;
  const names = status.refused.pcs.map((endpoint) => (pcName ?? ((one: string) => knownName(account, one)))(endpoint)).filter((name): name is string => name !== null);
  const pcs = names.length === 0 ? t("One of your PCs") : names.join(", ");
  const line = (() => {
    switch (status.refused.why) {
      case "other_list": return t("{pc} follows another list of your account, so this device did not join yours. Remove {pc} from your account, or reset it there; this device then joins by itself.", { pc: pcs });
      case "first_signer_removed": return t("A PC of yours removed the device that made your account's list, so this device did not join it.");
      case "first_signer_unknown": return t("Your PCs do not know the device that made your account's list, so this device did not join it.");
      default: return t("This device did not join your account's list.");
    }
  })();
  const title = t("This device is not in your account's list");
  const card = (
    <div className="modal account-approval" role="alertdialog" aria-modal="true" aria-label={title} data-testid="list-join-refusal" data-why={status.refused.why}>
      <h2 className="account-approval-title">{title}</h2>
      <p className="account-approval-error" role="alert">{line}</p>
      <p className="account-approval-note">{t("Allow this device from a device that is in the list.")}</p>
      <div className="account-approval-actions">
        <button type="button" className="btn" onClick={() => setClosed(shownFor)}>{t("Close")}</button>
      </div>
    </div>
  );
  return scrim ? createPortal(<div className="modal-scrim">{card}</div>, document.body) : card;
}

/** Both, where nothing else draws them: over the start screen and over an opened PC, each over a scrim of its own in the page's body while it is drawn. */
export function ListMoveNotices() {
  return <><ListMoveNotice scrim /><ListJoinRefusal scrim /></>;
}
