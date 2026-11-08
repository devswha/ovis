import "./RelayShell.css";

import { useEffect, useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

import { GLOBAL_RELAY } from "../../shared/relay-regions.ts";
import { myPcs, type MyPc } from "../lib/account/myPcs.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { dashboardPcs } from "../lib/relay/dashboard.ts";
import type { AccountView, KeyMismatch } from "../lib/relay/shellState.ts";
import { AccountFinePrint, AccountSignIn, CheckPcsButton, PcStatusLine } from "./AccountPcs.tsx";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { KeyId } from "./KeyId.tsx";
import { AddPcSheet, type AddPcSheetMode } from "./AddPcSheet.tsx";
import { RelayDashboard } from "./RelayDashboard.tsx";
import { describeUpdate } from "../lib/updateProgress.ts";
import type { RelayShellState } from "../lib/relay/shellState.ts";
import type { ObservedVersion } from "../lib/relay/updateFlow.ts";
import { codeFailureText, type TypedCodeFailure } from "./codeFailureText.ts";
import { relayFailureText } from "./relayFailureText.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";

export interface RelayShellProps {
  state: RelayShellState;
  /** how each saved PC answered the front page's latest check (pcStatus.ts), by server id */
  pcStatus?: ReadonlyMap<string, PcStatus>;
  /** Check now: probe the saved PCs again */
  onCheckPcs?: () => void;
  /** Explicit directory retry; independent of the liveness probe sweep. */
  onRefreshAccount?: () => void;
  /** Admission succeeded; only this action hands the scoped page to the PC app. */
  onOpenPc?: () => void;
  /** Reloaded independently after a scope navigation, never copied into session storage. */
  continuedAccount?: AccountView | null;
  /** Versions from admitted sessions only; a liveness probe never supplies one. */
  observedVersions?: ReadonlyMap<string, ObservedVersion>;
  /** on a PC's own page (`/s/<id>/`), where Back leads to the front page; the front page has no Back */
  scoped: boolean;
  /** an iPhone or iPad browser tab, where the pairing may not survive a week unvisited */
  iosTab: boolean;
  onPair: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onBack: () => void;
  onForget: () => void;
  /** a PC below the shell's minimum version with a managed install: install its latest release */
  onUpdate: () => void;
  /** pairing without a code: the digits on this screen are the ones the PC shows */
  /** `typed`: the digits typed from the PC's screen, when this phone may not show its own (state.typed) */
  onMatch: (typed?: string) => void;
  /** the front page's sign-in: off to the provider's pages */
  onSignIn?: (provider: AccountProvider) => void;
  /** a PC of the account this device is not paired with: compare digits with it */
  /** `typed`: added as a PC new in the account, so this device types the number that PC shows; `sheet`: the Add-a-PC sheet asked, in that mode, and goes on over the PC's own page */
  onJoin?: (pc: MyPc, options?: { typed?: boolean; sheet?: "new" | "join" }) => void;
  /** on a PC's own page: the join the dashboard's sheet started for this PC, which the sheet takes up again over the pairing screens */
  sheetJoin?: { mode: "new" | "join"; server_id: string; returnHash?: string } | null;
  onSignOut?: () => void;
  onLeave?: () => void;
  /** the sign-ins the account service offers (accountProvidersOf); GitHub alone by default */
  accountProviders?: readonly AccountProvider[];
  /** the relay each PC of the account's directory named (DirectoryPc.relay), for the dashboard's rows */
  directoryRelays?: readonly { server_id: string; relay: string | null }[];
  /** the shell's default relay origin, where the dashboard puts a PC with no known relay */
  defaultRelay?: string;
  /** this device, as the dashboard's map names it (deviceLabel) */
  meLabel?: string;
  /** Pair with a code: the field to type it in */
  onCodeStart: () => void;
  /** the code as typed; it is not kept anywhere else */
  onCodeSubmit: (code: string) => void;
  /** the ID a typed code found is the one the PC's screen shows */
  onCodeMatch: () => void;
}

/**
 * Adding a PC listed in the account: the six digits come from that PC's own screen, typed here, so a
 * PC someone else listed under a familiar name cannot be added with a tap. Kept in the input itself.
 */
export function TypedDigits({ pc, onSubmit, cancel }: { pc: string; onSubmit: (digits: string) => void; cancel: ReactNode }) {
  const t = useT();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem("digits") as HTMLInputElement;
    onSubmit(field.value.replace(/\s/g, ""));
  };
  return (
    <>
      <h1 className="relay-shell-title">{t("Type the number {name} shows", { name: pc })}</h1>
      <p className="relay-shell-copy">{t("{name} shows six digits on its own screen now. Type them here, then approve on {name}.", { name: pc })}</p>
      <p className="relay-shell-detail">{t("No number on {name}? Cancel, then tap {name} in your list.", { name: pc })}</p>
      <form className="relay-shell-code-form" onSubmit={submit}>
        <input name="digits" className="relay-shell-code-input" aria-label={t("Number on {name}", { name: pc })} inputMode="numeric" pattern="[0-9 ]{6,7}" maxLength={7} autoComplete="one-time-code" required autoFocus />
        <div className="relay-shell-actions"><button type="submit" className="btn btn-primary">{t("Add this PC")}</button>{cancel}</div>
      </form>
    </>
  );
}

/**
 * The field a code is typed in, kept in the input itself (src/AGENTS.md: secret input stays in the
 * DOM), as GitHub's device sign-in asks for the code its other screen shows.
 */
function CodeEntry({ failure, onSubmit, back }: { failure: TypedCodeFailure | null; onSubmit: (code: string) => void; back: ReactNode }) {
  const t = useT();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem("code") as HTMLInputElement;
    const code = field.value;
    field.value = "";
    onSubmit(code);
  };
  return (
    <>
      <h1 className="relay-shell-title">{t("Pair with a code")}</h1>
      <p className="relay-shell-copy">{t("On the PC, open Settings → Devices and PCs → Add a connection → Ovis relay (Connect, or Show a code to type, on an older Ovis). Type the code it shows here. Where the PC uses the Ovis account, sign in to the same account instead.")}</p>
      <form className="relay-shell-code-form" onSubmit={submit}>
        <input name="code" className="relay-shell-code-input" aria-label={t("Code from the PC")} placeholder="XXXXX-XXXXX"
          autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={32} required autoFocus />
        {failure !== null && <p className="relay-shell-detail" role="alert">{codeFailureText(t, failure)}</p>}
        <div className="relay-shell-actions">
          <button type="submit" className="btn btn-primary">{t("Pair")}</button>
          {back}
        </div>
      </form>
    </>
  );
}

/**
 * The id named and the id of the key that is not it, groups that differ marked, each labelled by
 * where it came from. Neither is called the PC's: a link names any id it likes, and only the PC's
 * own screen (Phone & devices) says which id is the PC's.
 */
function KeyIds({ mismatch, named }: { mismatch: KeyMismatch; named: "link" | "paired" }) {
  const t = useT();
  const expected = named === "link" ? t("ID this link names") : t("ID this phone paired with");
  const received = mismatch.from === "link" ? t("ID of the key this link carries") : t("ID of the key this phone saved");
  return (
    <>
    <dl className="relay-shell-keys">
      <dt>{expected}</dt>
      <dd><KeyId id={mismatch.expected} label={expected} /></dd>
      <dt>{received}</dt>
      <dd>
        {mismatch.received === null
          ? <span className="relay-shell-copy">{t("Not a valid key")}</span>
          : <KeyId id={mismatch.received} against={mismatch.expected} label={received} />}
      </dd>
    </dl>
    <p className="relay-shell-detail">{t("Only the PC itself shows its ID, at the top of Settings → Devices and PCs (My devices, or under the code, on an older Ovis). Marked groups differ.")}</p>
    </>
  );
}

/** How a PC whose Ovis does not update itself is brought up to date: the installer, or herdr's plugin. */
export const INSTALLER_COMMAND = "curl -fsSL https://ovis.sh/install.sh | sh";
export const PLUGIN_COMMANDS = "herdr plugin install devswha/ovis\nherdr plugin action invoke devswha.ovis.stop\nherdr plugin action invoke devswha.ovis.start";

/** A completed pairing owns its transport until Open PC or Cancel, including in continued scope. */
function ReadyCheckpoint({ open, cancel }: { open: () => void; cancel: () => void }) {
  const t = useT();
  const title = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [cancel]);
  return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
    <div ref={surface} className="modal add-pc-sheet" role="dialog" aria-modal="true" aria-labelledby={title} tabIndex={-1} data-add-pc-phase="ready">
      <header className="modal-header"><h2 id={title} className="modal-title" role="status">{t("Ready")}</h2></header>
      <footer className="modal-footer">
        <button type="button" className="btn" onClick={cancel}>{t("Cancel")}</button>
        <button type="button" className="btn btn-primary" onClick={open}>{t("Open PC")}</button>
      </footer>
    </div>
  </div>;
}

/**
 * The hosted shell's screens before the app: the saved PCs to pick from, the question before a
 * new PC is paired, the wait for the connection, and why one did not come up, each named in
 * `data-relay-state` for scripts. One card in the token gate's frame (AccessGate.css), so a phone
 * that pairs through the relay and one that pairs with a code see the same room.
 */
export function RelayShell({ state, pcStatus, onCheckPcs, onRefreshAccount, observedVersions, scoped, iosTab, onPair, onRetry, onCancel, onBack, onForget, onUpdate, onMatch, onCodeStart, onCodeSubmit, onCodeMatch, onOpenPc, continuedAccount, onSignIn, onJoin, sheetJoin = null, onSignOut, onLeave, accountProviders, directoryRelays = [], defaultRelay = GLOBAL_RELAY, meLabel }: RelayShellProps) {
  const t = useT();
  const account: AccountView | null = (state.kind === "list" || state.kind === "empty") && onSignIn ? state.account ?? null : null;
  const signIn = account?.kind === "signed-out" && onSignIn ? <AccountSignIn onSignIn={onSignIn} error={account.error} {...(accountProviders ? { providers: accountProviders } : {})} /> : null;
  // signed out, the front page is the sign-in alone: the QR route and this device's own pairings wait behind its links
  const [signedOutView, setSignedOutView] = useState<"sign-in" | "pair" | "saved">("sign-in");
  // the dashboard's Add-a-PC sheet (AddPcSheet.tsx): a PC's join in its mode, or how a PC is added; its QR route is the pairing screen with Back to the dashboard
  const [sheet, setSheet] = useState<{ pc: MyPc | null; mode: AddPcSheetMode } | null>(null);
  const [addingPc, setAddingPc] = useState(false);
  const saved = state.kind === "list" ? state.devices.length : 0;
  const view = account?.kind !== "signed-out" ? null : signedOutView === "saved" && saved === 0 ? "sign-in" : signedOutView;
  const signInFirst = view === "sign-in";
  const signInInstead = <div className="relay-shell-actions"><button type="button" className="btn" onClick={() => setSignedOutView("sign-in")}>{t("Sign in instead")}</button></div>;
  const name = state.kind === "confirm" || state.kind === "code-compare" ? state.offer.name ?? null
    : state.kind === "list" || state.kind === "empty" || state.kind === "code-entry" || state.kind === "code-looking" ? null : state.name;
  const pc = name ?? t("this PC");
  // a forged link is the identity-changed warning in its own words: there is no key of its to forget
  const stateName = state.kind === "failed" ? state.failure : state.kind === "outdated" ? "pc-outdated" : state.kind === "forged" ? "identity-changed" : state.kind;
  const back = scoped ? <button type="button" className="btn" onClick={onBack}>{t("Back")}</button> : null;
  const progress = state.kind === "outdated" && state.update.phase === "installing" ? describeUpdate({ phase: "building", step: state.update.step }) : null;
  const retry = <button type="button" className="btn btn-primary" onClick={onRetry}>{t("Try again")}</button>;
  const failure = state.kind === "failed" ? relayFailureText(t, state.failure, pc) : null;
  // the dashboard: the account's PCs once signed in, or, behind "Continue without an account", this device's own pairings (local mode)
  const devices = state.kind === "list" ? state.devices : [];
  const local = view === "saved" && state.kind === "list";
  if (!addingPc && account && (account.kind === "signed-in" || local)) {
    const signedIn = account.kind === "signed-in" ? account : null;
    return (
      <main className="relay-dash-screen" data-relay-state={stateName} data-account-state={account.kind}>
        {signedIn?.error && onRefreshAccount && <button type="button" className="btn" onClick={onRefreshAccount}>{t("Try again")}</button>}
        <RelayDashboard
          pcs={signedIn ? (signedIn.pcs === null ? null : dashboardPcs(signedIn.pcs, devices, directoryRelays)) : dashboardPcs(myPcs([], devices, { now: Date.now(), outdated: new Set([...(observedVersions ?? [])].filter(([, value]) => value.outdated).map(([id]) => id)) }), devices)}
          account={signedIn ? { provider: signedIn.provider } : null}
          defaultRelay={defaultRelay}
          meLabel={meLabel ?? t("This device")}
          error={signedIn?.error ?? null}
          {...(pcStatus ? { pcStatus } : {})}
          {...(onCheckPcs ? { onCheckPcs } : {})}
          onAddPc={() => setSheet({ pc: null, mode: "add" })}
          onOpenSheet={(pc, mode) => setSheet({ pc, mode })}
          {...(signedIn ? {} : { onSignIn: () => setSignedOutView("sign-in") })}
          {...(signedIn && onSignOut ? { onSignOut } : {})}
          {...(signedIn && onLeave ? { onLeave } : {})}
        />
        {/* the sheet's join leaves for the PC's own page, where the sheet goes on (sheetJoin) over the pairing screens */}
        {sheet && (
          <AddPcSheet mode={sheet.mode} pc={sheet.pc} state={state}
            onJoin={(pc, options) => onJoin?.(pc, { ...options, sheet: sheet.mode === "new" ? "new" : "join" })}
            onPair={onPair} onMatch={onMatch} onCancel={onCancel} onClose={() => setSheet(null)}
            onPairByQr={() => { setSheet(null); setAddingPc(true); }} />
        )}
      </main>
    );
  }
  // on the PC's own page, the join the sheet started goes on in the sheet: the question a link asks, the wait, the digits, and
  // how that PC's join failed; a PC with a new identity keeps the shell's own screen, whose ids and Forget the sheet does not carry
  const continued = scoped && sheetJoin !== null && (state.kind === "confirm" ? state.offer.server_id === sheetJoin.server_id
    : state.kind === "failed" ? state.server_id === sheetJoin.server_id && state.failure !== "identity-changed"
    : state.kind === "connecting" || state.kind === "compare" || state.kind === "ready");
  if (continued) {
    const joining: MyPc = (continuedAccount?.kind === "signed-in" ? continuedAccount.pcs?.find((row) => row.server_id === sheetJoin.server_id) : undefined)
      ?? { server_id: sheetJoin.server_id, name: pc, state: "needs-approval", last_seen_at: null, added_at: null, listed: true, paired: false, linked: false };
    return (
      <main className="relay-dash-screen" data-relay-state={stateName}>
        {continuedAccount !== undefined && <div inert>
          <RelayDashboard pcs={continuedAccount?.kind === "signed-in" && continuedAccount.pcs !== null ? dashboardPcs(continuedAccount.pcs, [], directoryRelays) : null}
            account={continuedAccount?.kind === "signed-in" ? { provider: continuedAccount.provider } : null}
            defaultRelay={defaultRelay} meLabel={meLabel ?? t("This device")} error={continuedAccount?.kind === "signed-in" ? continuedAccount.error : null}
            onAddPc={onBack} onOpenSheet={onBack} />
        </div>}
        {state.kind === "ready" && onOpenPc
          ? <ReadyCheckpoint open={onOpenPc} cancel={onCancel} />
          : <AddPcSheet mode={sheetJoin.mode} pc={joining} state={state} onJoin={() => {}} onPair={onPair} onMatch={onMatch} onRetry={onRetry} onCancel={onCancel} onClose={onBack} onPairByQr={onCodeStart} />}
      </main>
    );
  }
  return (
    <main className="relay-shell-screen" data-relay-state={stateName} {...(account ? { "data-account-state": account.kind } : {})}>
      <div className={signInFirst || state.kind === "compare" ? "relay-shell account-centered" : "relay-shell"}>
        <img src="/icons/icon-192.png?v=sheep1" alt="" width="44" height="44" className="relay-shell-mark" />
        {state.kind === "ready" && onOpenPc && <ReadyCheckpoint open={onOpenPc} cancel={onCancel} />}
        {account?.kind === "signing-in" && (
          <>
            <h1 className="relay-shell-title">{t("Signing in…")}</h1>
            <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /><span className="visually-hidden">{t("Signing in…")}</span></div>
          </>
        )}
        {signInFirst && (
          <>
            <h1 className="relay-shell-title">{t("Sign in to Ovis")}</h1>
            <p className="relay-shell-copy account-subtitle">{t("Your PCs and devices, through the Ovis relay.")}</p>
            {signIn}
            <AccountFinePrint />
            <div className="relay-shell-sign-in-links">
              <button type="button" className="account-link" onClick={() => setSignedOutView("pair")}>{t("Pair with a QR or code")}</button>
              {saved > 0 && (
                <button type="button" className="account-link" onClick={() => setSignedOutView("saved")}>
                  {saved === 1 ? t("Continue without an account (1 PC)") : t("Continue without an account ({count} PCs)", { count: saved })}
                </button>
              )}
            </div>
          </>
        )}
        {state.kind === "list" && account === null && (
          <>
            <h1 className="relay-shell-title">{t("Your PCs")}</h1>
            {onCheckPcs && <CheckPcsButton status={pcStatus ?? new Map()} onCheck={onCheckPcs} />}
            <ul className="relay-shell-pcs">
              {state.devices.map((device) => (
                <li key={device.server_id}>
                  <a className="relay-shell-pc" href={serverScopePath(device.server_id)}>
                    <span className="account-pc-text">
                      <span className="relay-shell-pc-name">{device.name ?? t("Unnamed PC")}</span>
                      {pcStatus?.get(device.server_id) && <PcStatusLine status={pcStatus.get(device.server_id)!} />}
                    </span>
                    <ChevronRight className="relay-shell-pc-glyph" aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
            <p className="relay-shell-copy">{t("To add another PC, scan the QR code it shows under Devices and PCs (Phone & devices on an older Ovis).")}</p>
            <div className="relay-shell-actions"><button type="button" className="btn" onClick={onCodeStart}>{t("Pair with a code")}</button></div>
          </>
        )}
        {(account === null ? state.kind === "empty" : view === "pair" || addingPc) && (
          <>
            <h1 className="relay-shell-title">{t("Scan the QR code on your PC")}</h1>
            <p className="relay-shell-copy">{t("On the PC, open Settings → Devices and PCs (Phone & devices on an older Ovis) and turn on remote access through the Ovis relay. The QR code there opens this app paired with that PC.")}</p>
            <div className="relay-shell-actions"><button type="button" className="btn" onClick={onCodeStart}>{t("Pair with a code")}</button>{back}</div>
            {account && (addingPc
              ? <div className="relay-shell-actions"><button type="button" className="btn" onClick={() => setAddingPc(false)}>{t("Back")}</button></div>
              : signInInstead)}
          </>
        )}
        {state.kind === "code-entry" && <CodeEntry failure={state.failure} onSubmit={onCodeSubmit} back={<button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button>} />}
        {state.kind === "code-looking" && (
          <>
            <h1 className="relay-shell-title">{t("Looking for the PC…")}</h1>
            <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /><span className="visually-hidden">{t("Looking for the PC…")}</span></div>
            <div className="relay-shell-actions"><button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button></div>
          </>
        )}
        {state.kind === "code-compare" && (
          <>
            <h1 className="relay-shell-title">{t("Does {name}'s screen show this ID?", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("The PC shows its ID at the top of Settings → Devices and PCs (My devices, or under the code, on an older Ovis). Pair only if every group matches.")}</p>
            <p className="relay-shell-code-id"><KeyId id={state.offer.server_id} label={t("ID of the PC this code found")} /></p>
            <div className="relay-shell-actions">
              <button type="button" className="btn btn-primary" onClick={onCodeMatch}>{t("It matches")}</button>
              <button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button>
            </div>
          </>
        )}
        {state.kind === "confirm" && (
          <>
            <h1 className="relay-shell-title">{t("Pair with {name}?", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("This phone gets a key of its own for {name}. The PC lists it under Devices and PCs (Phone & devices on an older Ovis), where it can be removed.", { name: pc })}</p>
            <div className="relay-shell-actions">
              <button type="button" className="btn btn-primary" onClick={onPair}>{t("Pair")}</button>
              <button type="button" className="btn" onClick={onCancel}>{t("Not now")}</button>
            </div>
          </>
        )}
        {state.kind === "connecting" && (
          <>
            <h1 className="relay-shell-title">{t("Connecting to {name}…", { name: pc })}</h1>
            <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /><span className="visually-hidden">{t("Connecting to {name}…", { name: pc })}</span></div>
            <div className="relay-shell-actions"><button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button></div>
          </>
        )}
        {state.kind === "compare" && state.typed && !state.confirmed && (
          state.wrong ? (
            <>
              <h1 className="relay-shell-title">{t("That is not the number {name} shows", { name: pc })}</h1>
              <p className="relay-shell-copy">{t("Nothing was added. Tap the PC again to compare a new number, and type the one its own screen shows.")}</p>
              <div className="relay-shell-actions"><button type="button" className="btn" onClick={onCancel}>{t("Back")}</button></div>
            </>
          ) : <TypedDigits pc={pc} onSubmit={onMatch} cancel={<button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button>} />
        )}
        {state.kind === "compare" && !(state.typed && !state.confirmed) && (
          <>
            <h1 className="relay-shell-title">{t("Does {name} show this number?", { name: pc })}</h1>
            <p className="relay-shell-digits" aria-label={state.digits.split("").join(" ")}>{`${state.digits.slice(0, 3)} ${state.digits.slice(3)}`}</p>
            {state.confirmed ? (
              <div className="relay-shell-wait" role="status">
                <div className="boot-spinner" aria-hidden="true" />
                <p className="relay-shell-detail">{t("Approve this phone on {name} to finish.", { name: pc })}</p>
              </div>
            ) : (
              <p className="relay-shell-copy">{t("If they match, approve this phone on {name}.", { name: pc })}</p>
            )}
            <div className="relay-shell-actions">
              {!state.confirmed && <button type="button" className="btn btn-primary" onClick={() => onMatch()}>{t("The numbers match")}</button>}
              <button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button>
            </div>
          </>
        )}
        {state.kind === "failed" && failure !== null && (
          <>
            <h1 className="relay-shell-title">{failure.title}</h1>
            <p className="relay-shell-copy">{failure.copy}</p>
            {state.failure === "identity-changed" ? (
              <>
                {state.mismatch && <KeyIds mismatch={state.mismatch} named="paired" />}
                <div className="relay-shell-actions">
                  <button type="button" className="btn btn-danger" onClick={onForget}>{t("Forget this PC")}</button>
                  {back}
                </div>
              </>
            ) : (failure.retry || back) && <div className="relay-shell-actions">{failure.retry && retry}{back}</div>}
          </>
        )}
        {state.kind === "outdated" && (
          <>
            <h1 className="relay-shell-title">{t("Update Ovis on {name}", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("{name} runs Ovis {version}; this app needs {min} or newer.", { name: pc, version: state.serverVersion, min: state.minVersion })}</p>
            {state.update.phase === "reading" && <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /></div>}
            {state.update.phase === "offer" && (
              <>
                <p className="relay-shell-copy relay-shell-more">{t("Update it from here: the PC installs the latest release and restarts Ovis, then this app reconnects.")}</p>
                <div className="relay-shell-actions">
                  <button type="button" className="btn btn-primary" onClick={onUpdate}>{t("Update now")}</button>
                  {back}
                </div>
              </>
            )}
            {state.update.phase === "manual" && (
              <>
                <p className="relay-shell-copy relay-shell-more">{t("Its Ovis does not update itself. On the PC, run the installer:")}</p>
                <pre className="relay-shell-command"><code>{INSTALLER_COMMAND}</code></pre>
                <p className="relay-shell-copy relay-shell-more">{t("Or, for the herdr plugin, reinstall it and restart Ovis:")}</p>
                <pre className="relay-shell-command"><code>{PLUGIN_COMMANDS}</code></pre>
                <div className="relay-shell-actions">{retry}{back}</div>
              </>
            )}
            {state.update.phase === "installing" && (
              <div className="relay-shell-wait" role="status">
                <div className="boot-spinner" aria-hidden="true" />
                <p className="relay-shell-detail">{progress ? `${progress.step}: ${t(progress.label)}` : t("Asking the PC to update…")}</p>
              </div>
            )}
            {state.update.phase === "restarting" && (
              <div className="relay-shell-wait" role="status">
                <div className="boot-spinner" aria-hidden="true" />
                <p className="relay-shell-detail">{t("Waiting for {name} to restart…", { name: pc })}</p>
              </div>
            )}
            {state.update.phase === "failed" && (
              <>
                <p className="relay-shell-copy relay-shell-more">{t("The update did not finish.")}</p>
                {state.update.detail !== null && <p className="relay-shell-detail"><code>{state.update.detail}</code></p>}
                <div className="relay-shell-actions">
                  <button type="button" className="btn btn-primary" onClick={onUpdate}>{t("Update now")}</button>
                  {back}
                </div>
              </>
            )}
          </>
        )}
        {state.kind === "forged" && (
          <>
            <h1 className="relay-shell-title">{t("This link is not {name}'s", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("It carries a key that is not this PC's, so this phone will not pair with it. To pair, scan a new QR code on the PC itself.")}</p>
            {state.mismatch && <KeyIds mismatch={state.mismatch} named="link" />}
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "forgotten" && (
          <>
            <h1 className="relay-shell-title">{t("This phone forgot {name}", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("The link you opened carried a different key, so it is not used to pair again. To pair, scan a new QR code on the PC itself.")}</p>
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "failed" && state.detail !== null && <p className="relay-shell-detail"><code>{state.detail}</code></p>}
        {iosTab && scoped && <p className="relay-shell-hint">{t("Add to Home Screen to stay paired: Safari may clear this page's storage after a week without a visit.")}</p>}
      </div>
    </main>
  );
}
