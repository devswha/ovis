/**
 * Manage account's devices for an account whose signed list this device is in (docs/account-list.md, "On a
 * device"): the devices the list holds, by the names this device opens, each saying what it may do, and a key the
 * list holds with no name. A device of power `full` removes any of them, and with it what came in through it where
 * the person ticks it; the removal is the list's, so the key never comes back.
 */
import { useEffect, useState } from "react";

import { listView } from "../../shared/account-list.ts";
import type { DeviceNotice } from "../../shared/account-devices-api.ts";
import type { AccountList, AccountListView, ListedDevice } from "../lib/account/accountList.ts";
import { inList } from "../lib/account/listLeave.ts";
import { cameInThrough, removeFromList, type Arrival, type RemoveOutcome } from "../lib/account/listRemoveDevice.ts";
import { currentLocale, useT, type Translate } from "../lib/i18n.ts";
import { NotMeButton } from "./BlockOutcomes.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** The page's list as it shows now, kept current. */
export function useListView(list: AccountList | null): AccountListView | null {
  const [view, setView] = useState<AccountListView | null>(() => list?.view() ?? null);
  useEffect(() => {
    if (list === null) { setView(null); return; }
    setView(list.view());
    return list.subscribe(setView);
  }, [list]);
  return view;
}

/** Whether Manage account draws the account's devices from its list: this device follows it and is in it. */
export function showsListDevices(view: AccountListView | null, account: string): view is AccountListView {
  return view !== null && view.account === account && view.status.at === "following" && view.status.standing === "in";
}

/** A row of the list: a device, or a key the list holds that no kind made anything (`key` alone). */
type Row = { readonly kind: "device"; readonly device: ListedDevice } | { readonly kind: "signer"; readonly key: string };

const keyOf = (row: Row): string => (row.kind === "device" ? row.device.key : row.key);

/** What a row says besides its name: this device, a device that only watches, a browser that is let in for a while. */
function roleOf(t: Translate, device: ListedDevice): string | null {
  if (device.self) return t("This device");
  if (device.role === "watch") return t("View only");
  if (device.until !== null) return t("Borrowed browser, until {time}", { time: new Date(device.until * 1000).toLocaleString(currentLocale(), { weekday: "short", hour: "2-digit", minute: "2-digit" }) });
  return null;
}

/** What the person is told when a removal did not go through: never that it did. */
function failureOf(t: Translate, outcome: Exclude<RemoveOutcome, { removed: true }>, name: string): string {
  if (outcome.why === "stopped") return t("The account service cannot change the list right now. To remove a device, use Revoke on each PC.");
  return t("{name} could not be removed. Try again.|device", { name });
}

export function ListDevices({ list, view, onLeave }: { readonly list: AccountList; readonly view: AccountListView; readonly onLeave?: () => Promise<void> }) {
  const t = useT();
  const [asked, setAsked] = useState<Row | "self" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // what this device may sign on, as its copy stands with this view: only a device of power `full` removes anybody
  const writer = list.writer();
  const nameless = writer === null ? [] : listView(writer.state).signers.map((row) => row.key);
  const rows: Row[] = [...view.devices.map((device): Row => ({ kind: "device", device })), ...nameless.map((key): Row => ({ kind: "signer", key }))];
  const nameOf = (row: Row): string => (row.kind === "signer" ? t("Unknown key") : row.device.name?.label ?? t("Unnamed device"));
  const arrivalName = (arrival: Arrival): string => {
    if (arrival.kind === "pc") return view.pcs.find((pc) => pc.endpoint === arrival.endpoint)?.name?.label ?? t("Unnamed PC");
    if (arrival.kind === "signer") return t("Unknown key");
    return view.devices.find((device) => device.key === arrival.key)?.name?.label ?? t("Unnamed device");
  };

  return (
    <section className="account-manage-part" aria-label={t("Devices")}>
      <h3 className="account-manage-h">{t("Devices")}</h3>
      <ul className="account-manage-list" data-testid="account-devices" data-source="list">
        {rows.map((row) => {
          const self = row.kind === "device" && row.device.self;
          const role = row.kind === "device" ? roleOf(t, row.device) : null;
          return (
            <li key={keyOf(row)} className="account-manage-row" data-list-device={row.kind}>
              <span className="account-manage-name account-manage-named">
                <span className="account-manage-line">{nameOf(row)}</span>
                {role !== null && <span className="account-manage-dim account-manage-tag">{role}</span>}
              </span>
              {self && onLeave && <button type="button" className="btn account-head-btn" data-action="leave-account" onClick={() => setAsked("self")}>{t("Disconnect")}</button>}
              {!self && writer !== null && <button type="button" className="btn account-head-btn" data-action="remove-device" onClick={() => { setNote(null); setAsked(row); }}>{t("Remove")}</button>}
            </li>
          );
        })}
      </ul>
      {note !== null && <p className="settings-condition" role="status" data-testid="list-device-note">{note}</p>}
      {asked === "self" && onLeave && (
        <ConfirmDialog title={t("Remove this device?")} body={t("Every PC of the account removes this device. To use it again, sign in on it and allow it from another device.")}
          confirmLabel={t("Disconnect")} onClose={() => setAsked(null)} onConfirm={async () => { await onLeave(); setAsked(null); }} />
      )}
      {asked !== null && asked !== "self" && (
        <RemoveDialog list={list} target={asked} name={nameOf(asked)} arrivalName={arrivalName}
          onClose={() => setAsked(null)} onRemoved={(name) => { setAsked(null); setNote(t("{name} was removed from your account.", { name })); }} />
      )}
    </section>
  );
}

/**
 * Remove's question: the device goes for good, and what came in through it is listed by name below, each to tick:
 * a lost phone may have let in the person's own PCs, a stolen one the thief's devices. Nothing is ticked at first.
 */
function RemoveDialog({ list, target, name, arrivalName, onClose, onRemoved }: {
  readonly list: AccountList;
  readonly target: Row;
  readonly name: string;
  readonly arrivalName: (arrival: Arrival) => string;
  readonly onClose: () => void;
  readonly onRemoved: (name: string) => void;
}) {
  const t = useT();
  const key = keyOf(target);
  // read when the question opens: what came in through the key, by the list this device holds now
  const [arrivals] = useState<readonly Arrival[]>(() => {
    const writer = list.writer();
    return writer === null ? [] : cameInThrough(writer.state, key, writer.keys.key);
  });
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const remove = async (): Promise<void> => {
    const picked = arrivals.filter((_, index) => chosen.has(index));
    const outcome = await removeFromList(list, {
      keys: [key, ...picked.flatMap((arrival) => (arrival.kind === "pc" ? [] : [arrival.key]))],
      pcs: picked.flatMap((arrival) => (arrival.kind === "pc" ? [arrival.endpoint] : [])),
    }).catch((error: unknown): RemoveOutcome => {
      console.warn("Ovis: the device was not removed from the account's list", error instanceof Error ? error.name : error);
      return { removed: false, why: "unreached", retryAfterMs: null };
    });
    if (!outcome.removed) throw new Error(failureOf(t, outcome, name));
    onRemoved(name);
  };
  return (
    <ConfirmDialog title={t("Remove {name} from your account?|device", { name })}
      body={t("{name} loses access to every PC of your account for good. To use it again, sign in on it and allow it from another device.", { name })}
      confirmLabel={t("Remove")} onClose={onClose} onConfirm={remove}>
      {arrivals.length > 0 && (
        <fieldset className="account-manage-through" data-testid="came-in-through">
          <legend className="settings-description">{t("Came in through {name}:", { name })}</legend>
          {arrivals.map((arrival, index) => (
            <label key={arrival.kind === "pc" ? arrival.endpoint : arrival.key} className="account-manage-through-row">
              <input type="checkbox" checked={chosen.has(index)}
                onChange={() => setChosen((now) => { const next = new Set(now); if (!next.delete(index)) next.add(index); return next; })} />
              <span className="settings-label">{arrivalName(arrival)}</span>
            </label>
          ))}
          <p className="settings-hint">{t("If {name} was stolen, tick what you did not add yourself.", { name })}</p>
        </fieldset>
      )}
    </ConfirmDialog>
  );
}

/**
 * Whether "Not me" on a PC's notice of a new device is the list's to answer: the device it names is one the list
 * holds, other than this one, and this device may remove it. Otherwise the notice keeps today's blocks.
 */
export function listAnswersNotice(list: AccountList | null, view: AccountListView | null, notice: DeviceNotice): list is AccountList {
  if (list === null || view === null || view.account === null || notice.kind !== "admit" || !notice.open || notice.key === null || notice.account !== view.account) return false;
  return inList(view, view.account) && view.devices.some((device) => device.key === notice.key && !device.self) && list.writer() !== null;
}

/** "Not me" on a new device the list let in: one press puts it out of the list, and the notice says how that went. */
export function ListNotMeAction({ list, notice }: { readonly list: AccountList; readonly notice: DeviceNotice & { readonly key: string } }) {
  const t = useT();
  const [sending, setSending] = useState(false);
  const [said, setSaid] = useState<{ readonly text: string; readonly retry: boolean } | null>(null);
  const press = async (): Promise<void> => {
    setSending(true);
    setSaid(null);
    const outcome = await removeFromList(list, { keys: [notice.key], pcs: [] }).catch((error: unknown): RemoveOutcome => {
      console.warn("Ovis: the device was not removed from the account's list", error instanceof Error ? error.name : error);
      return { removed: false, why: "unreached", retryAfterMs: null };
    });
    setSending(false);
    setSaid(outcome.removed ? { text: t("{name} was removed from your account.", { name: notice.label }), retry: false }
      : { text: failureOf(t, outcome, notice.label), retry: outcome.why !== "stopped" });
  };
  if (said?.retry === false) return <p className="settings-hint" role="status" data-testid="list-not-me">{said.text}</p>;
  return <>
    <NotMeButton sending={sending} onPress={() => { void press(); }} />
    {said !== null && <p className="settings-hint" role="alert" data-testid="list-not-me">{said.text}</p>}
  </>;
}
