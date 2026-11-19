import { useCallback, useEffect, useState } from "react";

import { currentLocale, useT } from "../lib/i18n.ts";
import { fetchLockState, requestLock, requestUnlock } from "../lib/account/lock.ts";

/** Track B's GET /api/account/lock (S2-18): `preview` is what turning it on ends (T46), only while unlocked and bound. */
export interface LockState {
  readonly bound: boolean;
  /** whether this PC can confirm on its own screen; fixed by platform (Linux only this release) */
  readonly confirm: "available" | "unsupported";
  readonly locked: { readonly id: string; readonly at: string; readonly by: "pc" } | null;
  readonly strict: boolean;
  readonly preview?: {
    readonly rows: readonly { readonly id: string; readonly label: string; readonly origin: { readonly from: string; readonly how: string } | null; readonly file: "devices" | "account" }[];
    readonly grants: readonly ("token" | "portal" | "tailscale" | "open_lan" | "loopback")[];
  };
}

/**
 * Strict mode (device table P11, T46, T47, T49, N7, R10; hub rule: only on a PC bound to an account). The switch is
 * on this PC's own window only, and it only asks: the PC's screen confirms it. Before turning it on, every row and
 * grant it ends is named; once on, turning it off names that lock. What it cannot cover is said, not hidden.
 */
export function StrictModePanel({ state, local, onTurnOn, onTurnOff }: { state: LockState; local: boolean; onTurnOn: () => void; onTurnOff: (lock: string) => void }) {
  const t = useT();
  if (!state.bound) return <p className="settings-hint">{t("Strict mode needs this PC signed in to an Ovis account.")}</p>;
  if (state.confirm === "unsupported" && state.locked === null) return <p className="settings-hint">{t("Strict mode needs a confirmation on this PC's screen, which only Linux has for now.")}</p>;
  const grantName = { token: t("access token"), portal: "Portal", tailscale: "Tailscale", open_lan: t("open local network"), loopback: t("this PC's browser without proof") } as const;
  return (
    <div className="strict-mode">
      <p className="settings-hint">{t("Only devices added on this PC's own screen or terminal can come in.")}</p>
      {state.strict && state.locked === null && <p className="settings-hint">{t("This PC could not read its safety log, so it stays locked.")}</p>}
      {state.locked !== null && <p>{t("On since {time}.", { time: new Date(state.locked.at).toLocaleString(currentLocale(), { dateStyle: "medium", timeStyle: "short" }) })}</p>}
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
        : <button type="button" className="btn" onClick={() => onTurnOff(state.locked!.id)}>{t("Turn off strict mode")}</button>)}
    </div>
  );
}

/** Settings → Devices: strict mode on a PC that offers it (account-opens-all/1), read again after each request. */
export function StrictModeSection({ offered, local }: { offered: boolean; local: boolean }) {
  const [state, setState] = useState<LockState | null>(null);
  const read = useCallback(() => fetchLockState().then(setState, (error: unknown) => {
    console.warn("Ovis: strict mode could not be read", error instanceof Error ? error.name : error);
    setState(null);
  }), []);
  useEffect(() => { if (offered) void read(); }, [offered, read]);
  if (!offered || state === null) return null;
  const ask = (request: Promise<string>) => { void request.then(read, (error: unknown) => console.warn("Ovis: strict mode was not asked for", error instanceof Error ? error.name : error)); };
  return <StrictModePanel state={state} local={local} onTurnOn={() => ask(requestLock())} onTurnOff={(lock) => ask(requestUnlock(lock))} />;
}
