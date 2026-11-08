import "./RelayShell.css";

import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";

import { GLOBAL_RELAY } from "../../shared/relay-regions.ts";
import { myPcs, type MyPc } from "../lib/account/myPcs.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { dashboardPcs } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import type { AccountView, RelayShellState } from "../lib/relay/shellState.ts";
import type { ObservedVersion } from "../lib/relay/updateFlow.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { AddPcSheet, type AddPcSheetMode } from "./AddPcSheet.tsx";
import { codeFailureText, type TypedCodeFailure } from "./codeFailureText.ts";
import { RelayDashboard } from "./RelayDashboard.tsx";
import {
  INSTALLER_COMMAND,
  PLUGIN_COMMANDS,
  RelayShellCardContent,
  TypedDigits,
} from "./RelayShellScreens.tsx";

export { INSTALLER_COMMAND, PLUGIN_COMMANDS, TypedDigits };

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
 * The field a code is typed in, kept in the input itself (src/AGENTS.md: secret input stays in the
 * DOM), as GitHub's device sign-in asks for the code its other screen shows.
 */
export function CodeEntry({ failure, looking = false, onSubmit, back }: { readonly failure: TypedCodeFailure | null; readonly looking?: boolean | undefined; readonly onSubmit: (code: string) => void; readonly back: ReactNode }) {
  const t = useT();
  const id = useId();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!looking) onSubmit((event.currentTarget.elements.namedItem("code") as HTMLInputElement).value);
  };
  const label = t("Code from the PC");
  return (
    <>
      <h1 className="relay-shell-title">{t("Pair with a code")}</h1>
      <p className="relay-shell-copy">{t("On the PC, open Settings → Devices and PCs → Add a connection → Ovis relay (Connect, or Show a code to type, on an older Ovis). Type the code it shows here. Where the PC uses the Ovis account, sign in to the same account instead.")}</p>
      <form className="relay-shell-code-form" onSubmit={submit}>
        <label className="relay-shell-field-label" htmlFor={`${id}-code`}>{label}</label>
        <input id={`${id}-code`} name="code" className="input relay-shell-code-input" aria-label={label} placeholder="XXXXX-XXXXX" disabled={looking} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={32} required autoFocus />
        {failure !== null && <p className="account-error" role="alert">{codeFailureText(t, failure)}</p>}
        <div className="relay-shell-actions">
          <button type="submit" className="btn btn-primary" aria-busy={looking ? "true" : undefined} disabled={looking}>{looking ? t("Looking for the PC…") : t("Pair")}</button>
          {back}
        </div>
      </form>
    </>
  );
}

/** A completed pairing owns its transport until Open PC or Cancel, including in continued scope. */
export function ReadyCheckpoint({ open, cancel }: { readonly open: () => void; readonly cancel: () => void }) {
  const t = useT();
  const title = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [cancel]);
  return (
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
      <div ref={surface} className="modal add-pc-sheet" role="dialog" aria-modal="true" aria-labelledby={title} tabIndex={-1} data-add-pc-phase="ready">
        <header className="modal-header"><h2 id={title} className="modal-title" role="status">{t("Ready")}</h2></header>
        <footer className="modal-footer">
          <button type="button" className="btn" onClick={cancel}>{t("Cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={open}>{t("Open PC")}</button>
        </footer>
      </div>
    </div>
  );
}

/**
 * The hosted shell's screens before the app: the sign-in column, the dashboard, the continued
 * sheet over the dashboard frame across a scoped join, and the pairing/recovery screens.
 */
export function RelayShell(props: RelayShellProps) {
  const { state, pcStatus, onCheckPcs, onRefreshAccount, observedVersions, scoped, onPair, onRetry, onCancel, onBack, onMatch, onCodeStart, onOpenPc, continuedAccount, onSignIn, onJoin, sheetJoin = null, onSignOut, onLeave, directoryRelays = [], defaultRelay = GLOBAL_RELAY, meLabel } = props;
  const t = useT();
  const account: AccountView | null = (state.kind === "list" || state.kind === "empty") && onSignIn ? state.account ?? null : null;
  const [signedOutView, setSignedOutView] = useState<"sign-in" | "pair" | "saved">("sign-in");
  const [sheet, setSheet] = useState<{ pc: MyPc | null; mode: AddPcSheetMode } | null>(null);
  const [addingPc, setAddingPc] = useState(false);
  const saved = state.kind === "list" ? state.devices.length : 0;
  const signedOutOrSigningIn = account?.kind === "signed-out" || account?.kind === "signing-in";
  const view = !signedOutOrSigningIn ? null : signedOutView === "saved" && saved === 0 ? "sign-in" : signedOutView;
  const signInFirst = view === "sign-in";
  const name = state.kind === "confirm" || state.kind === "code-compare" ? state.offer.name ?? null
    : state.kind === "list" || state.kind === "empty" || state.kind === "code-entry" || state.kind === "code-looking" ? null : state.name;
  const pc = name ?? t("this PC");
  const stateName = state.kind === "failed" ? state.failure : state.kind === "outdated" ? "pc-outdated" : state.kind === "forged" ? "identity-changed" : state.kind;
  const devices = state.kind === "list" ? state.devices : [];
  const local = view === "saved" && state.kind === "list";

  if (!addingPc && account && (account.kind === "signed-in" || local)) {
    const signedIn = account.kind === "signed-in" ? account : null;
    const outdatedIds = new Set([...(observedVersions ?? [])].filter(([, value]) => value.outdated).map(([id]) => id));
    return (
      <main className="relay-dash-screen" data-relay-state={stateName} data-account-state={account.kind}>
        {signedIn?.error && onRefreshAccount && <button type="button" className="btn" onClick={onRefreshAccount}>{t("Try again")}</button>}
        <RelayDashboard
          pcs={signedIn ? (signedIn.pcs === null ? null : dashboardPcs(signedIn.pcs, devices, directoryRelays)) : dashboardPcs(myPcs([], devices, { now: Date.now(), outdated: outdatedIds }), devices)}
          account={signedIn ? { provider: signedIn.provider } : null}
          defaultRelay={defaultRelay}
          meLabel={meLabel ?? t("This device")}
          error={signedIn?.error ?? null}
          {...(pcStatus ? { pcStatus } : {})}
          {...(onCheckPcs ? { onCheckPcs } : {})}
          onAddPc={() => setSheet({ pc: null, mode: "add" })}
          onOpenSheet={(target, mode) => setSheet({ pc: target, mode })}
          {...(signedIn ? {} : { onSignIn: () => setSignedOutView("sign-in") })}
          {...(signedIn && onSignOut ? { onSignOut } : {})}
          {...(signedIn && onLeave ? { onLeave } : {})}
        />
        {sheet && (
          <AddPcSheet mode={sheet.mode} pc={sheet.pc} state={state} onJoin={(target, options) => onJoin?.(target, { ...options, sheet: sheet.mode === "new" ? "new" : "join" })} onPair={onPair} onMatch={onMatch} onCancel={onCancel} onClose={() => setSheet(null)} onPairByQr={() => { setSheet(null); setAddingPc(true); }} />
        )}
      </main>
    );
  }

  const continued = scoped && sheetJoin !== null && (state.kind === "confirm" ? state.offer.server_id === sheetJoin.server_id
    : state.kind === "failed" ? state.server_id === sheetJoin.server_id && state.failure !== "identity-changed"
    : state.kind === "connecting" || state.kind === "compare" || state.kind === "ready");
  if (continued) {
    const joining: MyPc = (continuedAccount?.kind === "signed-in" ? continuedAccount.pcs?.find((row) => row.server_id === sheetJoin.server_id) : undefined)
      ?? { server_id: sheetJoin.server_id, name: pc, state: "needs-approval", last_seen_at: null, added_at: null, listed: true, paired: false, linked: false };
    return (
      <main className="relay-dash-screen" data-relay-state={stateName}>
        {continuedAccount !== undefined && <div inert>
          <RelayDashboard pcs={continuedAccount?.kind === "signed-in" && continuedAccount.pcs !== null ? dashboardPcs(continuedAccount.pcs, [], directoryRelays) : null} account={continuedAccount?.kind === "signed-in" ? { provider: continuedAccount.provider } : null} defaultRelay={defaultRelay} meLabel={meLabel ?? t("This device")} error={continuedAccount?.kind === "signed-in" ? continuedAccount.error : null} onAddPc={onBack} onOpenSheet={onBack} />
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
        <RelayShellCardContent props={props} view={view} signInFirst={signInFirst} saved={saved} addingPc={addingPc} setSignedOutView={setSignedOutView} setAddingPc={setAddingPc} />
      </div>
    </main>
  );
}
