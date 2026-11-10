import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, RefreshCw, X } from "lucide-react";

import "./ConnectPhoneDialog.css";
import "./DevicesPanel.css";

import type { Machine } from "../../shared/machines.ts";
import type { AddPcPreset } from "../lib/actions.ts";
import type { AccountSession } from "../lib/account/store.ts";
import { pcAccountStatus } from "../lib/account/join.ts";
import { ACCOUNT_QR_ALONE_MS, ACCOUNT_QR_POLL_MS, ACCOUNT_QR_WATCH_EVENT, accountQrNoticeWaiting, accountQrPending, joinedBy, newestRelayDevice, resetAccountQrWatch, stopAccountQrWatch, takeAccountQrNotice, watchEndedAccountQr, type AccountQrBaseline } from "../lib/accountQrWatch.ts";
import { ApiError, cancelRelayCode, endPairing, fetchDevices, findSshCandidates, findTailnetPcs, requestRelayOffer, revokeAllDevices, startPairing, type SshCandidate } from "../lib/api.ts";
import { apiFetch } from "../lib/api-request-id.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import type { PhonePlan } from "../lib/phone.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { announcePairingCode, inRelayShell, PAIRING_CODE_EVENT, type RelayState } from "../lib/useRelay.ts";
import type { PairedDevice, PairingCode } from "../../shared/protocol.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { PROVIDER_NAMES } from "./AccountPcs.tsx";
import { PhonePanel, QrReveal, ShareLink } from "./PhonePanel.tsx";
import { QrCode } from "./QrCode.tsx";
import { failureText, openOwnOffer, RelayPairing, statusText } from "./RelayPanel.tsx";
import { RelaySignIn } from "./RelaySignIn.tsx";
import { SettingsQuery, Toggle } from "./SettingsControls.tsx";
import { PortalPanel } from "./PortalPanel.tsx";
import { usePortal } from "../lib/portal.ts";
import { CompactPair } from "./CompactPair.tsx";

/** the sheet's ways, one tab each: PCs over SSH, phones and browsers on this PC's address, and the Ovis relay through the account */
export type ConnectTab = "ssh" | "devices" | "relay";

/** the dialog open on a phone: a touch screen, or a window as narrow as one */
const PHONE_QUERY = "(pointer: coarse), (max-width: 768px)";

/**
 * The label of a device paired through the relay under this phone's own name, for a quiet hint.
 * A name is no proof (two iPhones share one, and any device can be renamed), so it never stands in
 * for the phone's pairing: the relay key is the hosted shell's, out of this page's reach.
 */
export function sameNameRelayDevice(devices: readonly PairedDevice[], label: string): string | null {
  return devices.find((device) => device.via_relay === true && !device.current && device.label === label)?.label ?? null;
}

/** whether the relay can be offered here at all: a server with the route, a direct page, not the hosted shell */
export const relayOffered = (relay: RelayState): boolean => !relay.unsupported && relay.status !== null && !inRelayShell();

/** the relay is on: connecting or online, nothing blocking it */
const relayOn = (relay: RelayState): boolean => relay.status !== null && relay.status.blocked === null && relay.status.phase !== "off";

/**
 * The tabs this window gets, in their order: only the ways it can use. SSH is the owner's, on a page of this PC (not
 * the hosted shell, not a device that only watches); the relay's tab is the owner's on a direct page of a PC that has
 * the relay. Phones and devices is always there.
 */
export function connectTabs({ sshOffered, relay, readOnly }: { sshOffered: boolean; relay: RelayState; readOnly: boolean }): ConnectTab[] {
  return [...(sshOffered ? ["ssh" as const] : []), "devices", ...(relayOffered(relay) && !readOnly ? ["relay" as const] : [])];
}

/** The Ovis account as the relay tab uses it: signed out, its sign-in on the link page; signed in, the account in Settings. */
export interface RelayAccount {
  /** the account service this page signs in with */
  service: string;
  /** the account's place in Settings, where this PC is added to it */
  onOpen: () => void;
  /** a sign-in from the relay tab finished: the page reads the account again */
  onSignedIn: () => void;
}

export interface ConnectPhoneDialogProps {
  plan: PhonePlan;
  /** an address a phone can open now, for the pairing code's QR code; null shows the code alone */
  pairUrl: string | null;
  relay: RelayState;
  /** a watching device or a Portal visitor: it reads, and starts nothing */
  readOnly: boolean;
  /** turning the relay on closes the open device gate */
  closesGate: boolean;
  /** a Portal visitor may not start pairing codes (the server refuses it) */
  canPair: boolean;
  /** this browser is signed in to the Ovis account */
  signedIn: boolean;
  /**
   * Signed in, with this PC in that account and its relay on: a new device joins by signing in to the
   * same account, and a device already in it approves it once by picking the matching number
   * (AccountApprovals, docs/account.md "Who may admit a device").
   */
  joinBySignIn: boolean;
  /** the Ovis account, where this page offers it: the relay is used through it */
  account: RelayAccount | null;
  /** the Add PC dialog, its address filled in when a found PC was picked; null where PCs are not added from here */
  onAddPc: ((preset?: AddPcPreset) => void) | null;
  /** the roster: which found PCs are added already, and the PCs saved in herdr that wait for Connect */
  machines: readonly Machine[];
  /** Connect on a PC saved in herdr: its own setup dialog */
  onConnectMachine: (machine: Machine) => void;
  /**
   * The relay tab's QR code may put this PC in an account, and the dialog then says which and by which device: while
   * that can still come, or is on screen, a device that pairs does not close the dialog (`held`).
   */
  onPairingHeld?: (held: boolean) => void;
  /** every device was revoked from the relay tab's "Not me": the page reads how it is in again */
  onRevokedAll?: () => void;
  onClose: () => void;
}

/**
 * Settings → Devices and PCs → Add a connection, as herdr's Add a machine: one tab per way, the PCs each way
 * finds listed with Add, and a field to type one. SSH lists the PCs saved in herdr, the hosts of this PC's ssh
 * config and its Tailscale login's other PCs, each opening Add PC with its address. Phones and devices holds
 * what a phone or browser opens this PC with: its Tailscale address, a pairing code, and Portal where installed.
 * The Ovis relay is used through the Ovis account, so its tab is the sign-in, or once signed in how a new device
 * joins. The relay and Tailscale stay apart: nothing on the SSH tab goes through the relay.
 */
export function ConnectPhoneDialog({ plan, pairUrl, relay, readOnly, closesGate, canPair, signedIn, joinBySignIn, account, onAddPc, machines, onConnectMachine, onPairingHeld, onRevokedAll, onClose }: ConnectPhoneDialogProps) {
  const t = useT();
  const id = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  // it stays up under the relay identity's confirmation, which Back or its own close then leaves for it
  usePhoneSheetBack(() => { onClose(); }, true, true);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // gone from the page (a pairing closed it): its listener goes a moment later, and the key is Settings'
      if (surface.current === null) return;
      if (event.key !== "Escape" || event.isComposing || nativeModalOver(surface.current)) return;
      // an approval or a confirmation opened over this dialog takes its own Escape
      if (document.querySelector('[role="alertdialog"]') !== null) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, surface]);

  const phone = useMediaQuery(PHONE_QUERY);
  const tabs = connectTabs({ sshOffered: onAddPc !== null && !readOnly && !inRelayShell(), relay, readOnly });
  // a phone mostly connects itself; a PC's window opens on the PCs
  // except with something to say about the QR code its relay tab showed (lib/accountQrWatch.ts): that tab, then
  const [chosen, setChosen] = useState<ConnectTab>(() => (accountQrNoticeWaiting() && tabs.includes("relay") ? "relay" : phone && tabs.includes("devices") ? "devices" : tabs[0]!));
  useEffect(() => {
    const onWatch = (event: Event) => { if ((event as CustomEvent<{ notice: boolean }>).detail.notice) setChosen("relay"); };
    window.addEventListener(ACCOUNT_QR_WATCH_EVENT, onWatch);
    return () => window.removeEventListener(ACCOUNT_QR_WATCH_EVENT, onWatch);
  }, []);
  const tab = tabs.includes(chosen) ? chosen : tabs[0]!;
  // a tab once opened stays mounted while the dialog is: going back to Phones and devices keeps its code, not a new one
  const opened = useRef(new Set<ConnectTab>());
  opened.current.add(tab);
  const label: Record<ConnectTab, string> = { ssh: "SSH", devices: t("Phones and devices"), relay: t("Ovis relay") };

  return createPortal(
    // a Settings search hides no row in here
    <SettingsQuery.Provider value={[]}>
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal connect-phone-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h1 className="modal-title" id={`${id}-title`} tabIndex={-1}>{t("Add a connection")}</h1>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body connect-phone-body">
          {tabs.length > 1 && (
            <div className="segmented connect-tabs" role="group" aria-label={t("How to connect")}>
              {tabs.map((way) => <button key={way} type="button" aria-pressed={tab === way} data-tab={way} onClick={() => setChosen(way)}>{label[way]}</button>)}
            </div>
          )}
          {opened.current.has("ssh") && tabs.includes("ssh") && (
            <div className="connect-tab" data-tab-panel="ssh" hidden={tab !== "ssh"}>
              <SshTab machines={machines} onAddPc={onAddPc!} onConnectMachine={onConnectMachine} />
            </div>
          )}
          {opened.current.has("devices") && (
            <div className="connect-tab" data-tab-panel="devices" hidden={tab !== "devices"}>
              <DevicesTab plan={plan} pairUrl={pairUrl} readOnly={readOnly} canPair={canPair} phone={phone} />
            </div>
          )}
          {opened.current.has("relay") && tabs.includes("relay") && (
            <div className="connect-tab" data-tab-panel="relay" hidden={tab !== "relay"}>
              <RelayTab relay={relay} closesGate={closesGate} signedIn={signedIn} joinBySignIn={joinBySignIn} account={account} phone={phone} active={tab === "relay"} onPairingHeld={onPairingHeld} onRevokedAll={onRevokedAll} />
            </div>
          )}
        </div>
      </div>
    </div>
    </SettingsQuery.Provider>,
    document.body,
  );
}

/** how a found PC is known here: saved in herdr, a host of the ssh config, or a PC of the Tailscale login */
type FoundSource = "herdr" | SshCandidate["source"];
const SOURCE_LABEL: Record<FoundSource, string> = { herdr: "herdr", ssh_config: "ssh config", tailscale: "Tailscale" };

/**
 * SSH: the PCs found, each with Connect (saved in herdr, its own dialog), Add (Add PC with its address) or Added,
 * then a field for any other address. A window the server will not tell (an open LAN window, Portal, the relay)
 * gets the field alone.
 */
export function SshTab({ machines, onAddPc, onConnectMachine }: { machines: readonly Machine[]; onAddPc: (preset?: AddPcPreset) => void; onConnectMachine: (machine: Machine) => void }) {
  const t = useT();
  const [found, setFound] = useState<SshCandidate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reads, setReads] = useState(0);
  const [typed, setTyped] = useState("");
  // the Tailscale PCs whose Ovis is older than 0.5 (#3253), by MagicDNS name: told to update it there instead of Add
  const [outdated, setOutdated] = useState<ReadonlySet<string>>(new Set());
  // until that answer is in (it asks each PC, a few seconds), a Tailscale PC's Add waits (its own row, or the config
  // host that names it), so an older one is not added
  const [tailnetRead, setTailnetRead] = useState(false);
  useEffect(() => {
    let live = true;
    setTailnetRead(false);
    findTailnetPcs().then(({ pcs }) => {
      if (live) setOutdated(new Set(pcs.filter((pc) => pc.outdated).map((pc) => new URL(pc.url).hostname.toLowerCase())));
    }, () => undefined).finally(() => { if (live) setTailnetRead(true); });
    return () => { live = false; };
  }, [reads]);
  useEffect(() => {
    let live = true;
    setFailed(false);
    findSshCandidates().then(({ pcs }) => { if (live) setFound(pcs); }, (error: unknown) => {
      // a window the server will not tell (owner_only, read_only) gets the field alone; anything else says so, with Try again
      const refused = error instanceof ApiError && (error.code === "owner_only" || error.code === "read_only");
      if (!refused) console.warn("Ovis: the PCs to add over SSH could not be read", error instanceof Error ? error.name : error);
      if (!live) return;
      setFound([]);
      setFailed(!refused);
    });
    return () => { live = false; };
  }, [reads]);
  const saved = machines.filter((machine) => machine.herdr_profile_id !== undefined && machine.action_required === "connect");
  // a found PC is Added only as Add would add it: its own address, on ssh's default port and herdr's default session
  const added = (destination: string) => machines.some(({ target }) => target?.destination === destination && (target.port ?? 22) === 22 && target.session === undefined);
  const add = (event: FormEvent) => {
    event.preventDefault();
    const destination = typed.trim();
    if (destination !== "") onAddPc({ destination });
  };
  const row = (key: string, name: string, detail: string | null, source: FoundSource, action: ReactNode) => (
    <li key={key} className="connect-found-row">
      <span className="connect-found-name">{name}</span>
      {detail !== null && <span className="connect-found-detail">{detail}</span>}
      <span className="connect-found-source">{SOURCE_LABEL[source]}</span>
      {action}
    </li>
  );
  return (
    <>
      <p className="settings-description">{t("Add another PC over SSH.")}</p>
      {found === null ? <p className="settings-hint" role="status">{t("Looking for PCs…")}</p> : (saved.length > 0 || found.length > 0) && (
        <div className="connect-found">
          <ul className="connect-found-list">
            {saved.map((machine) => row(`herdr:${machine.id}`, machine.name, machine.target?.destination ?? null, "herdr",
              <button type="button" className="btn" onClick={() => onConnectMachine(machine)}>{t("Connect")}</button>))}
            {found.map((pc) => row(`${pc.source}:${pc.destination}`, pc.name, pc.detail, pc.source, added(pc.destination)
              ? <span className="connect-found-added"><Check aria-hidden="true" />{t("Added")}</span>
              : pc.tailnet !== undefined && outdated.has(pc.tailnet.toLowerCase())
              ? <span className="settings-hint">{t("Update Ovis on that PC to 0.5 first.")}</span>
              : <button type="button" className="btn" disabled={pc.tailnet !== undefined && !tailnetRead} aria-label={t("Add {name}", { name: pc.name })} onClick={() => onAddPc({ destination: pc.destination, name: pc.name })}>{t("Add")}</button>))}
          </ul>
        </div>
      )}
      {failed && (
        <div className="connect-found-failed" role="alert">
          <p className="settings-hint">{t("The PCs this PC knows could not be read.")}</p>
          <button type="button" className="btn" onClick={() => { setFound(null); setReads((count) => count + 1); }}><RefreshCw aria-hidden="true" />{t("Try again")}</button>
        </div>
      )}
      <form className="connect-ssh-form" onSubmit={add}>
        <label className="settings-label" htmlFor="connect-ssh-address">{t("Or type an SSH address")}</label>
        <div className="connect-ssh-field">
          <input id="connect-ssh-address" className="input" type="text" value={typed} placeholder="user@host" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => setTyped(event.target.value)} />
          <button type="submit" className="btn" disabled={typed.trim() === ""}>{t("Add")}</button>
        </div>
      </form>
    </>
  );
}

/**
 * Phones and devices: this PC's Tailscale address once it has one, a pairing code, and Portal where it can run. A way
 * this PC or window cannot use is left out, not explained.
 */
function DevicesTab({ plan, pairUrl, readOnly, canPair, phone }: { plan: PhonePlan; pairUrl: string | null; readOnly: boolean; canPair: boolean; phone: boolean }) {
  const t = useT();
  const { status: portal } = usePortal();
  const address = plan.kind === "here" || plan.kind === "served";
  const pairs = canPair && !readOnly;
  const portalShown = portal?.supported === true && (portal.phase !== "idle" || (portal.usable && portal.blocked === null));
  // nothing this window can use: one line on where it can be done, never an empty sheet
  if (!address && !pairs && !portalShown) return <p className="settings-description">{t("Open Ovis on the PC itself to add a connection.")}</p>;
  return (
    <>
      {address && (
        <section className="connect-section" aria-label="Tailscale">
          <p className="settings-label">Tailscale</p>
          <PhonePanel url={plan.url} phone={phone} />
        </section>
      )}
      {pairs && (
        <section className="connect-section" aria-label={t("Pairing code")}>
          <p className="settings-label">{t("Pairing code")}</p>
          <CodeRoute pairUrl={inRelayShell() ? null : pairUrl} startAtOnce phone={phone} compact />
        </section>
      )}
      {portalShown && (
        <section className="connect-section" aria-label="Portal">
          <PortalPanel readOnly={readOnly} />
        </section>
      )}
    </>
  );
}

/**
 * The Ovis relay, the owner's on a direct page. Signed out of the Ovis account, the sign-in; signed in, how a new
 * device joins, or the relay's switch while that cannot happen yet. Where the page has no account (none offered, or
 * its service cannot be reached), the relay's own pairing as before the account: its switch, its QR code and code to
 * type. One short line at most: what a blocked relay or the device gate means stays in More settings, or in the
 * switch's tooltip. With an account, either state also ends in the relay's QR code behind a press (AccountQr).
 */
export function RelayTab({ relay, closesGate, signedIn, joinBySignIn, account, phone, active = true, onPairingHeld, onRevokedAll }: {
  relay: RelayState; closesGate: boolean; signedIn: boolean; joinBySignIn: boolean; account: RelayAccount | null; phone: boolean;
  /** this tab is the one showing: its QR code comes down when another is opened */
  active?: boolean;
  onPairingHeld?: (held: boolean) => void;
  onRevokedAll?: () => void;
}) {
  const t = useT();
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [signedInProvider, setSignedInProvider] = useState<AccountSession["provider"] | null>(null);
  const signInView = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const view = signInView.current;
    // A completed sign-in leaves the next control ready, unless the person switched tabs.
    if (!signedIn || signedInProvider === null || view === null || view.closest("[hidden]") !== null) return;
    const next = view.querySelector<HTMLElement>("button:not(:disabled), a[href]")
      ?? view.closest('[role="dialog"]')?.querySelector<HTMLElement>("h2");
    next?.focus();
  }, [signedIn, signedInProvider, joinBySignIn]);
  const signInStatus = <p key="sign-in-status" className="visually-hidden" role="status" aria-live="polite">{signedInProvider === null ? null : t("Signed in with {provider}", { provider: PROVIDER_NAMES[signedInProvider] })}</p>;
  const on = relayOn(relay);
  useEffect(() => { if (on) setSwitchError(null); }, [on]);
  const switchable = relay.status?.blocked === null;
  const startError = relay.status !== null && relay.status.blocked === null && relay.status.phase === "off" ? relay.status.error : null;
  const switchRelay = async (next: boolean) => {
    setSwitchError(null);
    try { await relay.request(next ? "start" : "stop"); } catch (reason) { setSwitchError(failureText(reason)); }
  };
  // the switch's own name stays Ovis relay (the tab's, and what a screen reader hears); its visible label says
  // what turning it on does, and while the relay connects the same line says so, so on is not taken for online
  const connecting = on && relay.status?.phase !== "online";
  const relaySwitch = switchable && (
    <div className="connect-relay-switch" aria-busy={connecting || undefined} title={closesGate && !on ? t("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.") : undefined}>
      <span className="settings-label">{t("Let this PC be reached from anywhere")}{connecting && <span className="connect-relay-state" role="status"> · {statusText(t, relay.status!)}</span>}</span>
      <Toggle label={t("Ovis relay")} checked={on} onChange={(next) => { if (!relay.pending) void switchRelay(next); }} />
    </div>
  );
  const switchFailure = switchError !== null && <p className="settings-hint relay-error" role="alert">{switchError}</p>;
  if (account === null) return (
    <>
      {relaySwitch}
      {switchFailure}
      <RelayRoute relay={relay} readOnly={false} phone={phone} compact />
    </>
  );
  /* a start that failed before the link existed: the server answers phase off with its reason, and nothing retries it */
  const startFailure = switchError === null && startError !== null && <p className="settings-hint relay-error" role="alert">{t("The relay did not start: {message}", { message: startError })}</p>;
  // the same place in both account states, so a sign-in that finishes while the QR code is up leaves it up
  const qr = (ownSwitch: boolean) => (
    <AccountQr relay={relay} phone={phone} active={active} signedIn={signedIn} inAccount={joinBySignIn} onPairingHeld={onPairingHeld} onRevokedAll={onRevokedAll}
      relayControls={ownSwitch ? <>{relaySwitch}{switchFailure}{startFailure}</> : null} />
  );
  if (!signedIn) return (
    <>
      <div ref={signInView} className="connect-signin" data-testid="connect-signin">
        {signInStatus}
        <RelaySignIn service={account.service} onOpenAccount={account.onOpen} onSignedIn={(session) => { setSignedInProvider(session.provider); account.onSignedIn(); }} />
      </div>
      {qr(true)}
    </>
  );
  return (
    <>
      <div ref={signInView} className="connect-signin" data-testid="connect-signin">
        {signInStatus}
        {joinBySignIn ? <p className="connect-signin-lead">{t("On the new device, sign in to the same Ovis account.")}</p> : (
          <>
            {switchable && <p className="settings-description">{t("Turn on the relay, then add this PC to your account.")}</p>}
            {relaySwitch}
            {switchFailure}
            {startFailure}
            <button type="button" className="btn connect-signin-button" onClick={account.onOpen}>{t("Open the account")}</button>
          </>
        )}
      </div>
      {/* signed in, the relay's switch is above whenever the relay is not online */}
      {qr(false)}
    </>
  );
}

/** how long a QR code shown from the relay tab stays up, its renewals included */
export const ACCOUNT_QR_MAX_MS = 30 * 60_000;
/** a page hidden this long takes its QR code down: nobody is there to scan it */
export const ACCOUNT_QR_HIDDEN_MS = 60_000;

/**
 * Takes a QR code that is no longer shown out of use: the six-digit code it carried (`code`, when its offer came) is
 * ended on the PC, only if it is still the one pending, and the typed code bound to it goes with it (server/devices.ts
 * `endPairing`). A code that was not pending any more (used up, or replaced by another window's) ends nothing: the
 * typed code showing on the PC then is not this QR code's. The page's other places that show the ended code (Phones
 * and devices) are told it ran out, so none keeps a dead code up.
 * Before the offer came there is only a typed code to take back. True when the PC answered: from then on nothing this
 * QR code showed pairs.
 */
async function endShownCode(code: string | null): Promise<boolean> {
  if (code === null) return cancelRelayCode().then(() => true, () => false);
  try {
    if ((await endPairing(code)).cancelled) announcePairingCode({ code, expires_at: new Date(0).toISOString() });
    return true;
  } catch {
    // a PC that cannot end the six-digit code (it runs out by itself within ten minutes) still drops the typed one
    await cancelRelayCode().catch(() => undefined);
    return false;
  }
}

type AccountQrView =
  | { kind: "idle" }
  /** the press read the PC's account and devices, to tell afterwards what the QR code changed */
  | { kind: "starting" }
  | { kind: "shown" }
  /** a device paired and the PC is still in no account */
  | { kind: "alone"; device: string; id: string }
  | { kind: "joined"; account: string; device: string | null };

/**
 * The relay's QR code where the page has an Ovis account, behind a press: a signed-in device that scans it is paired
 * with its account key and then links itself and adds the PC (lib/relay/accountController.ts), so a PC in no account
 * joins the scanning device's account with nothing typed and no approval here (docs/account.md, "Adding a PC").
 * A code admits whoever holds it, so:
 * - nothing is asked of the PC until Show the QR code is pressed, and the code is ended when the QR code comes down:
 *   as the dialog closes or another tab opens, as the page goes (a reload, a closed tab), once the page was hidden
 *   for a minute, and 30 minutes after the press;
 * - when the PC goes from no account to one, the QR code gives way to which account and which device, with
 *   "Not me: revoke every device";
 * - a device that paired while the PC stays in no account is named as paired with this PC alone;
 * - a device that took the code just before it was ended links only afterwards: the PC is watched on after the QR
 *   code came down, outside this component (lib/accountQrWatch.ts), and what that finds is shown here.
 */
export function AccountQr({ relay, phone, active, signedIn, inAccount: inAccountHint, relayControls, onPairingHeld, onRevokedAll }: {
  relay: RelayState; phone: boolean; active: boolean; signedIn: boolean;
  /** what the page knows before this PC answered: it is in the account this browser is signed in to */
  inAccount: boolean;
  /** the relay's switch and its failures, where the tab shows them nowhere else; null where it does */
  relayControls: ReactNode;
  onPairingHeld?: (held: boolean) => void;
  onRevokedAll?: () => void;
}) {
  const t = useT();
  const id = useId();
  const [view, setView] = useState<AccountQrView>({ kind: "idle" });
  /** the view as last drawn, for what an effect's cleanup leaves behind: at an unmount, the one that was up */
  const drawn = useRef(view);
  drawn.current = view;
  /** a QR code was shown before: the button offers a new one */
  const [again, setAgain] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** the account this PC is in, as it last said; undefined until it answered */
  const [pcAccount, setPcAccount] = useState<string | null | undefined>(undefined);
  /** a QR code that came down is still being checked for a device it let in (lib/accountQrWatch.ts) */
  const [late, setLate] = useState(accountQrPending);
  /** the PC's account and devices as the press found them */
  const before = useRef<AccountQrBaseline | null>(null);
  /** bumped by every press and every take-down: an answer to an older one changes nothing */
  const run = useRef(0);
  /** the last take-down's requests: the next press waits for them, so it never ends the code it is about to get */
  const ending = useRef<Promise<boolean>>(Promise.resolve(true));
  const showButton = useRef<HTMLButtonElement>(null);
  const [refocus, setRefocus] = useState(0);
  // a notice that goes hands the focus to the button under it
  useLayoutEffect(() => { if (refocus > 0) showButton.current?.focus(); }, [refocus]);

  useEffect(() => {
    let live = true;
    pcAccountStatus(apiFetch).then((status) => { if (live) setPcAccount((known) => known === undefined ? status.account : known); }, () => undefined);
    return () => { live = false; run.current++; };
  }, []);

  // what the watch after a take-down found: shown here, wherever this was meanwhile (another tab, a closed dialog)
  useEffect(() => {
    const adopt = () => {
      setLate(accountQrPending());
      const kind = drawn.current.kind;
      // a QR code that is up, or on its way, reads the PC itself
      if (kind === "shown" || kind === "starting") return;
      const found = takeAccountQrNotice();
      if (found === null) return;
      run.current++;
      setNote(null);
      setAgain(true);
      if (found.kind === "joined") {
        setPcAccount(found.account);
        setView({ kind: "joined", account: found.account, device: found.device });
        return;
      }
      // from here on this reads the PC again, with that device still to name when the PC joins an account
      stopAccountQrWatch();
      before.current = { account: null, ids: new Set([...found.known.ids].filter((known) => known !== found.id)) };
      setView({ kind: "alone", device: found.device, id: found.id });
    };
    adopt();
    window.addEventListener(ACCOUNT_QR_WATCH_EVENT, adopt);
    return () => window.removeEventListener(ACCOUNT_QR_WATCH_EVENT, adopt);
  }, []);

  const takeDown = useCallback(() => {
    run.current++;
    setView({ kind: "idle" });
    setAgain(true);
  }, []);

  const show = async () => {
    const mine = ++run.current;
    setError(null);
    setNote(null);
    setView({ kind: "starting" });
    try {
      await ending.current;
      const [status, devices] = await Promise.all([pcAccountStatus(apiFetch), fetchDevices()]);
      if (mine !== run.current) return;
      // the QR code shown before may have let a device in, which the PC is still watched for or which waits to be
      // told: this press goes on from there
      const found = takeAccountQrNotice();
      const earlier = stopAccountQrWatch();
      setPcAccount(status.account);
      if (status.account !== null && (found?.kind === "joined" || earlier !== null)) {
        run.current++;
        setAgain(true);
        setView({ kind: "joined", account: status.account, device: found?.kind === "joined" ? found.device : joinedBy(devices, earlier!.ids, status.account)?.label ?? null });
        return;
      }
      // a device named as paired alone stays one this QR code has yet to tell of
      const ids = found?.kind === "alone" ? new Set([...found.known.ids].filter((known) => known !== found.id)) : earlier?.ids;
      before.current = { account: status.account, ids: status.account === null && ids !== undefined ? ids : new Set(devices.map((device) => device.id)) };
      setView({ kind: "shown" });
    } catch (reason) {
      if (mine !== run.current) return;
      setError(failureText(reason));
      setView({ kind: "idle" });
    }
  };

  const online = relay.status?.phase === "online" && relay.status.blocked === null;
  const shown = view.kind === "shown";
  // another tab, or a relay that went away: the QR code comes down, and a press on its way shows none
  useEffect(() => {
    if ((view.kind === "shown" || view.kind === "starting") && (!active || !online)) takeDown();
  }, [active, online, view.kind, takeDown]);

  // the six-digit code the QR code carries, as its offers announce it; ended when the QR code goes, however it goes
  useEffect(() => {
    if (!shown) return;
    let code: string | null = null;
    let ended = false;
    const onCode = (event: Event) => { code = (event as CustomEvent<PairingCode | undefined>).detail?.code ?? code; };
    // the page goes (a reload, a closed tab or window, another address): no cleanup runs then, and nothing after an
    // answer would, so the one request that ends this QR code's own code is sent to outlive the page
    const onPageHide = () => {
      if (ended) return;
      ended = true;
      ending.current = (code === null ? cancelRelayCode(true) : endPairing(code, true)).then(() => true, () => false);
      // a page kept for Back comes back without its QR code
      takeDown();
    };
    window.addEventListener(PAIRING_CODE_EVENT, onCode);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener(PAIRING_CODE_EVENT, onCode);
      window.removeEventListener("pagehide", onPageHide);
      if (!ended) ending.current = endShownCode(code);
      // a device may have taken the code a moment ago and link only now: unless this already says who came (a notice
      // took the QR code's place), the PC is watched on, also once this component is gone
      const next = drawn.current.kind;
      const known = before.current;
      if (known !== null && known.account === null && next !== "joined" && next !== "alone") watchEndedAccountQr(known, ending.current);
    };
  }, [shown, takeDown]);

  // a device named as paired alone may still put the PC in its account after its notice went (Done, a closed dialog)
  const aloneId = view.kind === "alone" ? view.id : null;
  useEffect(() => {
    if (aloneId === null) return;
    stopAccountQrWatch();
    return () => {
      const known = before.current;
      if (known === null || drawn.current.kind === "joined") return;
      watchEndedAccountQr({ account: null, ids: new Set([...known.ids, aloneId]) }, Promise.resolve(true), true);
    };
  }, [aloneId]);

  // while the QR code is up, and after a device paired without an account: what the PC says of its account and devices
  const watching = shown || view.kind === "alone";
  useEffect(() => {
    if (!watching) return;
    const mine = run.current;
    const known = before.current!;
    let asking = false;
    let alone: number | undefined;
    let hidden: number | undefined;
    let hiddenAt = 0;
    const until = Date.now() + ACCOUNT_QR_MAX_MS;
    /** either limit passed by the clock: a device that slept ran no timer, and may wake with the page still in sight */
    const overdue = () => Date.now() >= until || (hidden !== undefined && Date.now() - hiddenAt >= ACCOUNT_QR_HIDDEN_MS);
    const ask = async () => {
      if (overdue()) { takeDown(); return; }
      if (asking) return;
      asking = true;
      try {
        const [status, devices] = await Promise.all([pcAccountStatus(apiFetch), fetchDevices()]);
        if (mine !== run.current) return;
        setPcAccount(status.account);
        if (known.account === null && status.account !== null) {
          run.current++;
          setView({ kind: "joined", account: status.account, device: joinedBy(devices, known.ids, status.account)?.label ?? null });
          return;
        }
        const paired = newestRelayDevice(devices, known.ids);
        if (paired === null) return;
        // a PC already in an account: the device is paired, and its code is spent
        if (known.account !== null) { setNote(t("Paired: {name}.", { name: paired.label })); takeDown(); return; }
        alone ??= window.setTimeout(() => {
          if (mine === run.current) setView((current) => current.kind === "shown" ? { kind: "alone", device: paired.label, id: paired.id } : current);
        }, ACCOUNT_QR_ALONE_MS);
      } catch { /* the next round asks again */ } finally { asking = false; }
    };
    const poll = window.setInterval(() => void ask(), ACCOUNT_QR_POLL_MS);
    const cap = window.setTimeout(takeDown, ACCOUNT_QR_MAX_MS);
    const onVisibility = () => {
      if (document.hidden) {
        if (hidden === undefined) { hiddenAt = Date.now(); hidden = window.setTimeout(takeDown, ACCOUNT_QR_HIDDEN_MS); }
        return;
      }
      // back in sight: the clock says whether either limit passed meanwhile
      if (overdue()) takeDown();
      window.clearTimeout(hidden);
      hidden = undefined;
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(cap);
      window.clearTimeout(alone);
      window.clearTimeout(hidden);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [watching, takeDown]);

  // a device that pairs normally closes the dialog (Settings' device list); not while this may still have to say
  // which account the PC joined, or says it
  const held = (shown && before.current?.account === null) || late || view.kind === "alone" || view.kind === "joined" || confirming;
  useEffect(() => { onPairingHeld?.(held); }, [held, onPairingHeld]);
  useEffect(() => () => onPairingHeld?.(false), [onPairingHeld]);

  const dismiss = () => {
    takeDown();
    setRefocus((count) => count + 1);
  };
  const revokeAll = async () => {
    await revokeAllDevices();
    // nobody is left to watch for
    before.current = null;
    resetAccountQrWatch();
    setConfirming(false);
    setPcAccount(null);
    setNote(t("Every paired device was revoked. The access token, this PC and its Tailscale login get in as before."));
    dismiss();
    onRevokedAll?.();
  };

  const inAccount = pcAccount === undefined ? inAccountHint : pcAccount !== null;
  const pass = relay.status?.pass;
  // Ovis's relay refused this PC for its pass: it gets one through an account (docs/relay.md, "Relay pass")
  const needsAccount = !signedIn && relay.status?.phase === "error" && pass?.refused === true && pass.state !== "ok";
  // the switch says Connecting… itself
  const connecting = relay.status !== null && relay.status.blocked === null && relay.status.phase === "connecting";
  return (
    <section className="connect-account-qr" aria-labelledby={id} data-testid="connect-account-qr">
      <p className="settings-label" id={id}>{inAccount ? t("Add a device with a QR code") : t("Add with a QR code")}</p>
      <p className="settings-description">{inAccount
        ? t("A signed-in device that scans it is paired with this PC. Its other PCs still ask for one approval.")
        : t("Scan it with a device that is signed in to your Ovis account: this PC joins that account, with no number to type. A device that is not signed in is paired with this PC alone.")}</p>
      {view.kind === "joined" ? (
        <div className="connect-account-qr-notice" role="status" data-testid="connect-account-joined">
          <p className="settings-label" title={view.account}>{t("This PC joined an Ovis account ({id}).", { id: view.account.slice(0, 12) })}</p>
          {view.device !== null && <p className="settings-description">{t("Added by {device}.", { device: view.device })}</p>}
          <div className="phone-actions">
            <button type="button" className="btn btn-primary" onClick={dismiss}>{t("Done")}</button>
            <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>{t("Not me: revoke every device")}</button>
          </div>
        </div>
      ) : view.kind === "alone" ? (
        <div className="connect-account-qr-notice" role="status" data-testid="connect-account-alone">
          <p className="settings-description">{t("{device} is paired with this PC alone so far: it has not added this PC to an account. Sign in on it to add this PC to your account.", { device: view.device })}</p>
          <div className="phone-actions"><button type="button" className="btn" onClick={dismiss}>{t("Done")}</button></div>
        </div>
      ) : !online ? (
        <>
          {relayControls}
          {needsAccount ? <p className="settings-hint">{t("Sign in above first; then this PC can show its QR code.")}</p>
            : relay.status !== null && !(connecting && relayControls !== null) && <p className="settings-hint" role="status">{statusText(t, relay.status)}</p>}
        </>
      ) : shown ? <RelayRoute relay={relay} readOnly={false} phone={phone} compact /> : (
        <div className="phone-actions">
          <button ref={showButton} type="button" className="btn" disabled={view.kind === "starting"} aria-busy={view.kind === "starting" || undefined} onClick={() => void show()}>{again ? t("Show a new code") : t("Show the QR code")}</button>
        </div>
      )}
      {note !== null && view.kind === "idle" && <p className="settings-hint" role="status">{note}</p>}
      {error !== null && <p className="settings-hint relay-error" role="alert">{error}</p>}
      {confirming && (
        <ConfirmDialog title={t("Revoke every paired device?")}
          body={t("Every paired device loses its access to this PC, and this PC leaves that account. The access token, this PC and its Tailscale login still get in.")}
          confirmLabel={t("Revoke all")} onClose={() => setConfirming(false)} onConfirm={revokeAll} />
      )}
    </section>
  );
}

/**
 * The relay's way: its state (Blocked says why), a start that failed with Try again, the pairing QR
 * code once it is online, and the identity reset as a quiet last action. The switch is on its card.
 * On a phone, online, the phone pairs itself through its own offer in one tap, and the offer for
 * another device is a link to send, its QR code behind Show QR code.
 */
export function RelayRoute({ relay, readOnly, phone = false, pairHere = false, sameName = null, compact = false }: {
  relay: RelayState;
  /** Add a connection: no state line (the switch above says it), the QR code beside the code to type, no reset (More settings has it) */
  compact?: boolean;
  readOnly: boolean;
  phone?: boolean;
  /** a touch phone: Use the relay on this phone */
  pairHere?: boolean;
  /** a relay device under this phone's name: a hint, never proof that this phone is paired */
  sameName?: string | null;
}) {
  const t = useT();
  const { status, pending, request } = relay;
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [opening, setOpening] = useState(false);
  const resetButton = useRef<HTMLButtonElement>(null);
  if (status === null) return null;
  const pairThisPhone = async () => {
    setError(null);
    setOpening(true);
    try { await openOwnOffer((await requestRelayOffer()).url); } catch (reason) { setError(failureText(reason)); } finally { setOpening(false); }
  };
  // a start that failed before the link existed: the relay is off and nothing retries it (server/relay/service.ts)
  const notStarted = status.blocked === null && status.phase === "off" && status.error !== null;
  const start = async () => {
    setError(null);
    try { await request("start"); } catch (reason) { setError(failureText(reason)); }
  };
  return (
    <div className="connect-phone-relay">
      {!compact && <p className="relay-status" role="status">{statusText(t, status)}</p>}
      {readOnly && <p className="settings-condition" data-testid="relay-owner-help">{t("Only the PC's owner can control the relay, using a direct connection. Open Ovis on the PC or at its direct address.")}</p>}
      {notStarted && <p className="settings-hint relay-error" role="alert">{t("The relay did not start: {message}", { message: status.error })}</p>}
      {notStarted && !readOnly && (
        <div className="phone-actions">
          <button type="button" className="btn" disabled={pending} onClick={() => void start()}><RefreshCw aria-hidden="true" />{t("Try again")}</button>
        </div>
      )}
      {pairHere && !readOnly && status.blocked === null && status.phase === "off" && !notStarted && <p className="settings-description">{t("Turn it on with the switch above, then this phone can use it in one tap.")}</p>}
      {pairHere && status.phase === "online" && !readOnly && (
        <div className="connect-phone-self">
          <p className="settings-description">{t("Pairs this phone through the relay, so Ovis keeps working away from home.")}</p>
          {sameName !== null && <p className="settings-hint">{t("A device with this phone's name ({name}) is already paired through the relay.", { name: sameName })}</p>}
          <div className="phone-actions"><button type="button" className="btn btn-primary" disabled={opening} onClick={pairThisPhone}>{t("Use the relay on this phone")}</button></div>
        </div>
      )}
      {error !== null && <p className="settings-hint relay-error" role="alert">{error}</p>}
      {status.phase === "online" && !readOnly && <RelayPairing phone={phone} compact={compact} />}
      {/* a serve-only install refuses the reset too; an unreadable identity is what the reset mends */}
      {!compact && !readOnly && status.blocked !== "serve_only" && (
        <div className="phone-actions connect-phone-reset">
          <button ref={resetButton} type="button" className="btn btn-ghost" disabled={pending} onClick={() => setConfirmingReset(true)}>{t("Reset relay identity")}</button>
        </div>
      )}
      {confirmingReset && (
        <ConfirmDialog title={t("Reset the relay identity?")} body={t("Phones paired through the relay will need to scan a new code.")}
          confirmLabel={t("Reset")} onClose={() => setConfirmingReset(false)} onConfirm={async () => {
            await request("reset-identity");
            setConfirmingReset(false);
            // the confirmation hands focus back only when it is dismissed: after the reset it goes back here
            window.requestAnimationFrame(() => resetButton.current?.focus());
          }} />
      )}
    </div>
  );
}

/** the newest code request of any opening: the server keeps one pending code, so an older answer is a dead code */
let latestPairRequest = 0;

/**
 * A pairing code for a phone that can already open this address, with the QR code that opens it
 * with the code filled in. The server keeps one pending code: a code started here is announced, so
 * the Devices group watches for the phone it lets in (and closes the dialog once it is in), and the
 * relay's offer carries the same code.
 */
export function CodeRoute({ pairUrl, startAtOnce, phone = false, compact = false }: { pairUrl: string | null; startAtOnce: boolean; phone?: boolean; compact?: boolean }) {
  const t = useT();
  const [code, setCode] = useState<PairingCode | null>(null);
  const [left, setLeft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // a code request out: the buttons that would start another wait for it, so a second tap sends no second request
  const [busy, setBusy] = useState(false);
  const requesting = useRef(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const announcing = useRef(false);

  useEffect(() => {
    const onCode = (event: Event) => { if (!announcing.current) setCode((event as CustomEvent<PairingCode>).detail); };
    window.addEventListener(PAIRING_CODE_EVENT, onCode);
    return () => window.removeEventListener(PAIRING_CODE_EVENT, onCode);
  }, []);

  useEffect(() => {
    if (code === null) return;
    const tick = () => {
      const ms = Date.parse(code.expires_at) - Date.now();
      if (ms <= 0) { setCode(null); return; }
      setLeft(`${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [code]);

  const pair = async () => {
    if (requesting.current) return;
    requesting.current = true;
    setBusy(true);
    setError(null);
    const request = ++latestPairRequest;
    try {
      const fresh = await startPairing();
      // a dialog closed and opened again asked after this one: its answer is the code that pairs, not this one
      if (request !== latestPairRequest) return;
      setCode(fresh);
      announcing.current = true;
      try { announcePairingCode(fresh); } finally { announcing.current = false; }
    } catch (reason) { setError(failureText(reason)); }
    finally {
      requesting.current = false;
      setBusy(false);
    }
  };

  // once per opening from Pair a device; switching back to this route later waits for the button
  const started = useRef(false);
  useEffect(() => {
    if (!startAtOnce || started.current) return;
    started.current = true;
    void pair();
  }, [startAtOnce]);

  const spaced = code ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : "";
  const qrValue = code && pairUrl ? `${pairUrl.replace(/\/$/, "")}/?pair=${code.code}` : null;
  const newCode = <button type="button" className="btn" disabled={busy} aria-busy={busy || undefined} onClick={() => void pair()}><RefreshCw aria-hidden="true" />{t("New code")}</button>;
  // Connect a device: the QR code and the code side by side, Refresh and Copy; a code that ran out leaves Refresh
  if (compact) return (
    <div className="connect-phone-code" role="status">
      <CompactPair qr={qrValue} qrLabel={code === null ? t("Pairing code") : t("QR code that pairs a phone with code {code}", { code: code.code })}
        code={code?.code ?? null} shown={code === null ? null : spaced} codeLabel={t("Pairing code")} busy={busy}
        qrNote={busy ? undefined : code === null ? t("This code expired.") : pairUrl === null ? t("No address a phone can open: type the code instead.") : undefined}
        onRefresh={() => void pair()} />
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
  return (
    <div className="connect-phone-code">
      {code === null ? (
        <>
          <p className="settings-description">{t("For a phone that can already open this address: on the same Wi-Fi, or through a tunnel or proxy.")}</p>
          <div className="phone-actions"><button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void pair()}>{t("Get a pairing code")}</button></div>
        </>
      ) : phone ? (
        // on the phone itself the code is read off its screen and typed on the other device; its QR code waits behind Show QR code
        <div className="devices-pairing devices-pairing-phone" role="status">
          <p className="settings-label">{t("On the other device, enter this code")}</p>
          <p className="devices-code devices-code-large">{spaced}</p>
          <p className="settings-description">{t("Open the app's address on that device and enter it.")} {t("Expires in {time}.", { time: left })}</p>
          {qrValue !== null ? <ShareLink url={qrValue} copyLabel={t("Copy link")}>{newCode}</ShareLink> : <div className="phone-actions">{newCode}</div>}
          {qrValue !== null && <QrReveal value={qrValue} label={t("QR code that pairs a phone with code {code}", { code: code.code })} hint={t("Scan it with the other device's camera.")} />}
        </div>
      ) : (
        <div className="devices-pairing" role="status">
          {qrValue !== null && <QrCode value={qrValue} label={t("QR code that pairs a phone with code {code}", { code: code.code })} />}
          <div>
            <p className="settings-label">{t("On the other device, enter this code")}</p>
            <p className="devices-code">{spaced}</p>
            <p className="settings-description">
              {t(qrValue !== null ? "Or scan the QR code: it opens the app with the code filled in." : "Open the app's address on that device and enter it.")} {t("Expires in {time}.", { time: left })}
            </p>
            {qrValue !== null && (
              <p className="devices-link">
                <span className="settings-description">{t("Or send this link to it:")}</span>
                <a ref={linkRef} href={qrValue}>{qrValue}</a>
                <button type="button" className="btn btn-ghost" onClick={() => void copyText(qrValue, linkRef.current).then((ok) => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); } })}>{t(copied ? "Copied" : "Copy")}</button>
              </p>
            )}
            <div className="phone-actions">{newCode}</div>
          </div>
        </div>
      )}
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
}
