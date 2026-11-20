import { useCallback, useEffect, useState } from "react";

import { currentLocale, useT } from "../lib/i18n.ts";
import type { HealthAuth } from "../../shared/access.ts";
import { ApiError } from "../lib/api.ts";
import { CONFIRM_WINDOW_MS, fetchLockState, requestLock, requestUnlock } from "../lib/account/lock.ts";

/** GET /api/account/lock (server/account/lock-routes.ts): `preview` is what turning it on ends (T46), only while unlocked and bound. */
export interface LockState {
  readonly bound: boolean;
  /** whether this PC can confirm on its own screen; fixed by platform (Linux only this release) */
  readonly confirm: "available" | "unsupported";
  /** the lock in force, by its id */
  readonly locked: string | null;
  readonly strict: boolean;
  readonly preview?: {
    readonly rows: readonly { readonly id: string; readonly label: string; readonly origin: { readonly from: string; readonly how: string } | null; readonly file: "devices" | "account" }[];
    readonly grants: readonly ("token" | "portal" | "tailscale" | "open_lan" | "loopback")[];
  };
}

/** An act this window asked for, waiting on this PC's screen until `until` (ms). */
interface Asked { readonly kind: "lock" | "unlock"; readonly until: number }

function AskedLine({ asked }: { asked: Asked }) {
  const t = useT();
  return <p className="settings-hint" role="status">{t(asked.kind === "lock"
    ? "Strict mode is not on yet. Approve it on this PC's screen by {time}. To open that screen, run ovis confirm on this PC."
    : "Strict mode stays on until you approve turning it off on this PC's screen by {time}. To open that screen, run ovis confirm on this PC.",
  { time: new Date(asked.until).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" }) })}</p>;
}

/**
 * The access gate of a locked PC (T47, N4): the one thing a window there may do is ask to turn strict mode off, which
 * the PC's screen then approves. The server lets only this PC's own window read the lock; any other gets nothing here.
 */
export function StrictUnlockAsk() {
  const t = useT();
  const [lock, setLock] = useState<string | null>(null);
  const [asked, setAsked] = useState<Asked | null>(null);
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    let live = true;
    void fetchLockState().then((state) => { if (live) setLock(state.locked); }, () => { if (live) setLock(null); });
    return () => { live = false; };
  }, []);
  if (lock === null) return null;
  const ask = () => {
    const until = Date.now() + CONFIRM_WINDOW_MS;
    setRefused(false);
    void requestUnlock(lock).then(() => setAsked({ kind: "unlock", until }), (error: unknown) => {
      console.warn("Ovis: strict mode was not asked for", error instanceof Error ? error.name : error);
      setRefused(true);
    });
  };
  return (
    <div className="strict-mode">
      <p>{t("This PC is in strict mode.")}</p>
      <button type="button" className="btn" onClick={ask}>{t("Ask to turn strict mode off")}</button>
      {refused && <p className="settings-hint" role="status">{t("This PC did not take the request. Try again.")}</p>}
      {asked !== null && <AskedLine asked={asked} />}
    </div>
  );
}

/** Why the PC refused a request (server/account/lock-routes.ts codes, folded). */
interface Refusal { readonly kind: "local_required" | "already" | "no_screen_proof" | "lock_removals_pending" | "other"; readonly detail: string | null }

function refusalOf(error: unknown): Refusal {
  const code = error instanceof ApiError ? error.code : null;
  const detail = error instanceof ApiError ? error.detail : null;
  if (code === "local_required" || code === "no_screen_proof" || code === "lock_removals_pending") return { kind: code, detail };
  return { kind: code === "already_locked" || code === "not_locked" ? "already" : "other", detail };
}

/**
 * Strict mode (device table P11, T46, T47, T49, N7, R10; hub rule: only on a PC bound to an account). The switch is
 * on this PC's own window only, and it only asks: the PC's screen confirms it. Before turning it on, every row and
 * grant it ends is named; once on, turning it off names that lock. What it cannot cover is said, not hidden.
 */
export function StrictModePanel({ state, local, asked = null, refused = null, onTurnOn, onTurnOff }: { state: LockState; local: boolean; asked?: Asked | null; refused?: Refusal | null; onTurnOn: () => void; onTurnOff: (lock: string) => void }) {
  const t = useT();
  if (!state.bound) return <p className="settings-hint">{t("Strict mode needs this PC signed in to an Ovis account.")}</p>;
  if (state.confirm === "unsupported" && state.locked === null) return <p className="settings-hint">{t("Strict mode needs a confirmation on this PC's screen, which only Linux has for now.")}</p>;
  const grantName = { token: t("access token"), portal: "Portal", tailscale: "Tailscale", open_lan: t("open local network"), loopback: t("this PC's browser without proof") } as const;
  return (
    <div className="strict-mode">
      <p className="settings-hint">{t("Only devices added on this PC's own screen or terminal can come in.")}</p>
      {state.strict && state.locked === null && <p className="settings-hint">{t("This PC could not read its safety log, so it stays locked.")}</p>}
      {state.locked !== null && <p className="settings-hint">{t("While it is on, use this PC through the Ovis desktop app or a terminal on it.")}</p>}
      {state.locked === null && state.preview !== undefined && (state.preview.rows.length > 0 || state.preview.grants.length > 0) && (
        <>
          <p>{t("Turning it on ends:")}</p>
          <ul className="strict-mode-ends">
            {state.preview.rows.map((row) => <li key={row.id}>{row.label}</li>)}
            {state.preview.grants.map((grant) => <li key={grant}>{grantName[grant]}</li>)}
          </ul>
        </>
      )}
      <p className="settings-hint">{t("It does not cover anyone signed in to this computer as you, and cannot stop an older Ovis installed by hand.")}</p>
      {local && (state.locked === null
        ? <button type="button" className="btn" onClick={onTurnOn}>{t("Turn on strict mode")}</button>
        : <button type="button" className="btn" onClick={() => onTurnOff(state.locked!)}>{t("Turn off strict mode")}</button>)}
      {refused !== null && <p className="settings-hint" role="status">{{
        local_required: t("Turn strict mode on or off in a browser on this PC itself."),
        already: t("Strict mode changed already. This shows it as it is now."),
        no_screen_proof: t("Strict mode needs a confirmation on this PC's screen, which only Linux has for now."),
        lock_removals_pending: t("Strict mode stays on until this PC finishes signing out the devices it ended. Try again shortly."),
        // the PC's own words come after: a state folder it cannot write does not get better by trying again
        other: t("This PC did not take the request. Try again."),
      }[refused.kind]}{refused.kind === "lock_removals_pending" && refused.detail !== null && <> {refused.detail}</>}</p>}
      {asked !== null && <AskedLine asked={asked} />}
    </div>
  );
}

/** Settings → Devices: strict mode on a PC that offers it (account-opens-all/1), read again after each request. */
export function StrictModeSection({ offered, auth }: { offered: boolean; auth: HealthAuth | null }) {
  const [state, setState] = useState<LockState | null>(null);
  const [asked, setAsked] = useState<Asked | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  // this PC's own window, as the server decided it for this request: loopback, no proxy (server/access.ts "local")
  const local = auth?.via === "local";
  const read = useCallback(() => fetchLockState().then(setState, (error: unknown) => {
    console.warn("Ovis: strict mode could not be read", error instanceof Error ? error.name : error);
    setState(null);
  }), []);
  useEffect(() => { if (offered) void read(); }, [offered, read]);
  // the approval happens on another page: read again when this window comes back, and drop the line once it expires
  useEffect(() => {
    if (asked === null) return;
    const back = () => { void read(); };
    window.addEventListener("focus", back);
    const timer = setTimeout(() => { setAsked(null); void read(); }, Math.max(0, asked.until - Date.now()));
    return () => { window.removeEventListener("focus", back); clearTimeout(timer); };
  }, [asked, read]);
  const lock = state?.locked ?? null;
  useEffect(() => { setAsked(null); }, [lock]);
  if (!offered || state === null) return null;
  const ask = (kind: Asked["kind"], request: () => Promise<string>) => {
    setRefused(null);
    // taken before sending: the PC's own window starts when it gets the request, never earlier
    const until = Date.now() + CONFIRM_WINDOW_MS;
    void request().then(() => { setAsked({ kind, until }); return read(); }, (error: unknown) => {
      console.warn("Ovis: strict mode was not asked for", error instanceof Error ? error.name : error);
      setRefused(refusalOf(error));
      return read();
    });
  };
  return <StrictModePanel state={state} local={local} asked={asked} refused={refused} onTurnOn={() => ask("lock", requestLock)} onTurnOff={(id) => ask("unlock", () => requestUnlock(id))} />;
}
