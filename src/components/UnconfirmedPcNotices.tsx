import { Monitor } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ACCOUNT_PCS_CHANGED_EVENT } from "../lib/account/myPcs.ts";
import { newPcNoticeKey } from "../lib/account/newPcNotice.ts";
import { ACCOUNT_SIGN_OUT_EVENT, AccountServiceError, indexedAccountService, SignedOutError, type AccountService, type DirectoryPc } from "../lib/account/service.ts";
import type { AccountProvider, AccountSession } from "../lib/account/store.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { NewPcNotice } from "./NewPcNotices.tsx";

import "./DevicePairedNotice.css";
import "./UpdateControls.css";

/** security-triage condition 3: Add only while the listing is this young, by its added_at; after it, Remove alone */
const ADD_WINDOW_MS = 10 * 60_000;
/** the add a Sign in again was pressed for, by account and PC: the sign-in comes back as a page load, which goes on with it once */
const PENDING_ADD = "ovis:confirm-pc";

type Listing = { readonly session: AccountSession; readonly pcs: readonly DirectoryPc[]; readonly pending: string | null };
type Problem = { readonly text: string; readonly signInAgain: boolean };

function takePendingAdd(account: string): string | null {
  try {
    const kept = sessionStorage.getItem(PENDING_ADD);
    sessionStorage.removeItem(PENDING_ADD);
    const parsed: unknown = kept === null ? null : JSON.parse(kept);
    return typeof parsed === "object" && parsed !== null && (parsed as { account?: unknown }).account === account && typeof (parsed as { server_id?: unknown }).server_id === "string"
      ? (parsed as { server_id: string }).server_id : null;
  } catch { return null; }
}

function keepPendingAdd(account: string, serverId: string): void {
  try { sessionStorage.setItem(PENDING_ADD, JSON.stringify({ account, server_id: serverId })); } catch { /* not kept: Add is pressed again after the sign-in */ }
}

/** the confirm refusals about the sign-in alone (docs/account.md) say so, with Sign in again: a fresh own sign-in may pass them */
function refusal(t: Translate, error: Error): Problem {
  switch (error instanceof AccountServiceError ? error.code : null) {
    case "session_not_fresh": return { text: t("Sign in again to add it: your sign-in is more than ten minutes old."), signInAgain: true };
    case "own_sign_in_required": return { text: t("Sign in on this device to add it."), signInAgain: true };
    case "two_step_required": return { text: t("Turn on two-step sign-in with your sign-in provider, then sign in again to add it."), signInAgain: true };
    default: return { text: t("The PC could not be added. Try again."), signInAgain: false };
  }
}

/**
 * PCL-1: the PCs a device code listed in the account (anyone may type one for any PC) and no app's own sign-in confirmed,
 * each offered to this device while its sign-in is an app's own; a device code's sign-in is offered nothing. Read on
 * mount, focus and when the account's PCs change. `tellConfirmed`: after Add, the PC's new-PC card (C3) is drawn here,
 * where no NewPcNotices tells of it already. `onSignInAgain`: a fresh own sign-in, after which the add goes on.
 */
export function UnconfirmedPcNotices({ service = indexedAccountService, enabled = true, tellConfirmed = true, now = Date.now, onSignInAgain }: {
  readonly service?: AccountService;
  readonly enabled?: boolean;
  readonly tellConfirmed?: boolean;
  readonly now?: () => number;
  readonly onSignInAgain?: ((provider: AccountProvider) => void) | undefined;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [confirmed, setConfirmed] = useState<readonly DirectoryPc[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!enabled) { setListing(null); return; }
    let version = 0;
    const read = async (): Promise<void> => {
      const mine = ++version;
      try {
        const session = await service.session();
        if (mine !== version) return;
        if (session === undefined) { setListing(null); return; }
        const directory = service.forSignIn(session);
        const [own, pcs] = await Promise.all([directory.ownSignIn(), directory.listUnconfirmedPcs()]);
        if (mine !== version) return;
        // a device code's sign-in cannot confirm, and it is no one's to remove a PC with: nothing is offered to it
        setListing((prior) => own ? { session, pcs, pending: prior?.session.account === session.account ? prior.pending : takePendingAdd(session.account) } : null);
      } catch (error) {
        if (mine !== version) return;
        if (error instanceof SignedOutError) setListing(null);
        else if (error instanceof Error) console.warn("Ovis: the account's unconfirmed PCs could not be read", error.name);
        else throw error;
      }
    };
    const visibleRead = (): void => { if (document.visibilityState === "visible") void read(); };
    const signInChanged = (): void => { setListing(null); setConfirmed([]); void read(); };
    void read();
    document.addEventListener("visibilitychange", visibleRead);
    window.addEventListener("focus", visibleRead);
    window.addEventListener(ACCOUNT_SIGN_OUT_EVENT, signInChanged);
    window.addEventListener(ACCOUNT_PCS_CHANGED_EVENT, visibleRead);
    return () => {
      version++;
      document.removeEventListener("visibilitychange", visibleRead);
      window.removeEventListener("focus", visibleRead);
      window.removeEventListener(ACCOUNT_SIGN_OUT_EVENT, signInChanged);
      window.removeEventListener(ACCOUNT_PCS_CHANGED_EVENT, visibleRead);
    };
  }, [service, enabled]);

  if (listing === null) return null;
  const { session } = listing;
  const told = new Set(confirmed.map((pc) => pc.server_id));
  return (
    <>
      {listing.pcs.filter((pc) => !told.has(pc.server_id) && !removed.has(pc.server_id)).map((pc) => (
        <UnconfirmedPcNotice key={`${session.account}:${pc.server_id}`} pc={pc} session={session} service={service} now={now} retry={listing.pending === pc.server_id}
          {...(onSignInAgain ? { onSignInAgain } : {})}
          onConfirmed={(row) => setConfirmed((prior) => [...prior.filter((each) => each.server_id !== row.server_id), row])}
          onRemoved={() => setRemoved((prior) => new Set([...prior, pc.server_id]))} />
      ))}
      {tellConfirmed && confirmed.map((pc) => <NewPcNotice key={`${session.account}:new:${pc.server_id}`} pc={pc} session={session} dismissalKey={newPcNoticeKey(session.account, pc)} />)}
    </>
  );
}

function UnconfirmedPcNotice({ pc, session, service, now, retry, onSignInAgain, onConfirmed, onRemoved }: {
  readonly pc: DirectoryPc;
  readonly session: AccountSession;
  readonly service: AccountService;
  readonly now: () => number;
  readonly retry: boolean;
  readonly onSignInAgain?: (provider: AccountProvider) => void;
  readonly onConfirmed: (row: DirectoryPc) => void;
  readonly onRemoved: () => void;
}) {
  const t = useT();
  const { resolvedLanguage } = useSettings();
  const added = Date.parse(pc.added_at);
  const youngAt = (at: number): boolean => !(at - added > ADD_WINDOW_MS);
  const [young, setYoung] = useState(() => youngAt(now()));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!young) return;
    const timer = setTimeout(() => setYoung(false), Math.max(0, Math.min(ADD_WINDOW_MS, added + ADD_WINDOW_MS - now())));
    return () => clearTimeout(timer);
  }, [young, added, now]);

  const act = async (work: () => Promise<void>, failed: (error: Error) => Problem): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    try { await work(); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      setProblem(failed(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const directory = service.forSignIn(session);
  // the ten minutes are checked again at the press: a page left open never adds an old listing
  const add = (): Promise<void> => act(async () => {
    if (!youngAt(now())) { setYoung(false); return; }
    const row = await directory.confirmPc(pc);
    window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
    onConfirmed(row);
  }, (error) => refusal(t, error));
  const remove = (): Promise<void> => act(async () => {
    await directory.deletePc(pc.server_id);
    window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
    onRemoved();
  }, () => ({ text: t("The PC could not be removed. Try again."), signInAgain: false }));
  const latestAdd = useRef(add);
  latestAdd.current = add;
  useEffect(() => { if (retry) void latestAdd.current(); }, [retry]);

  const time = new Date(added).toLocaleTimeString(resolvedLanguage, { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="update-notice is-paired device-notice" role="status" data-unconfirmed-pc={pc.server_id}>
      <Monitor aria-hidden="true" />
      <span className="device-notice-text">
        {young && <span>{t("Add this PC to your account?")}</span>}
        <span>{t("Name the PC gave itself: \"{name}\"", { name: pc.label })}</span>
        <span className="settings-hint">{t("A PC was added to your account with a sign-in code at {time}.", { time })}{young ? ` ${t("Add it only if you typed that code on that PC's own screen a moment ago.")}` : ""}</span>
        {problem !== null && <span className="account-error" role="alert">{problem.text}</span>}
      </span>
      <div className="device-paired-actions">
        {problem?.signInAgain === true && onSignInAgain !== undefined && (
          <button type="button" className="btn" disabled={busy} onClick={() => { keepPendingAdd(session.account, pc.server_id); onSignInAgain(session.provider); }}>{t("Sign in again")}</button>
        )}
        {young ? (
          <>
            <button type="button" className="btn" disabled={busy} onClick={add}>{t("Add|account pc")}</button>
            <button type="button" className="btn" disabled={busy} onClick={remove}>{t("No|account pc")}</button>
          </>
        ) : <button type="button" className="btn" disabled={busy} onClick={remove}>{t("Remove from my account")}</button>}
      </div>
    </div>
  );
}
