import { UserRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { shellAccountActions } from "../lib/account/hostedSignIn.ts";
import { shownOf } from "../lib/account/listLeave.ts";
import { closePcNotice, pcNoticeClosed } from "../lib/account/newPcNotice.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { ACCOUNT_SIGN_OUT_EVENT, AccountServiceError, indexedAccountService, SignedOutError, type JoinedAccount } from "../lib/account/service.ts";
import { ACCOUNT_SESSION_EVENT, indexedAccountStore, type AccountSession } from "../lib/account/store.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { PROVIDER_NAMES } from "./AccountPcs.tsx";
import { methodRefusalText } from "./AccountMethods.tsx";

import "./DevicePairedNotice.css";
import "./UpdateControls.css";

/** Where this device keeps that it told a sign-in which account its way in was joined to: per account, way in and joining. */
const joinedNoticeKey = (session: AccountSession, joined: JoinedAccount): string =>
  `ovis:joined-account:${JSON.stringify([session.account, session.provider, joined.at])}`;

interface Told { readonly session: AccountSession; readonly joined: JoinedAccount; readonly key: string }

/**
 * Told once, until closed: the sign-in stored here was joined to an account that already had its way in's verified
 * email (GET /v1/session `joined`), which this names by the way in it was made with and its masked email. Not my account
 * takes this way in back out of that account (Not me on its own provider, which ends its sign-ins) and signs out here.
 */
export function JoinedNotice() {
  const t = useT();
  const locale = useLocale();
  const [told, setTold] = useState<Told | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    let version = 0;
    const read = async (): Promise<void> => {
      const mine = ++version;
      try {
        // read, never written: a refresh by the read below writes the stored sign-in, whose event reads it once more
        const session = await indexedAccountStore.get("session");
        const joined = session === undefined ? null : await indexedAccountService.forSignIn(session).joined();
        if (mine !== version) return;
        const key = session === undefined || joined === null ? null : joinedNoticeKey(session, joined);
        setTold(session === undefined || joined === null || key === null || pcNoticeClosed(key) ? null : { session, joined, key });
      } catch (error) {
        if (mine !== version) return;
        setTold(null);
        if (!(error instanceof SignedOutError)) console.warn("Ovis: the account this sign-in joined could not be read", error instanceof Error ? error.name : error);
      }
    };
    const changed = (): void => { void read(); };
    changed();
    for (const name of [ACCOUNT_SESSION_EVENT, ACCOUNT_SIGN_OUT_EVENT]) window.addEventListener(name, changed);
    return () => {
      version++;
      for (const name of [ACCOUNT_SESSION_EVENT, ACCOUNT_SIGN_OUT_EVENT]) window.removeEventListener(name, changed);
    };
  }, []);

  if (told === null) return null;
  const { session, joined, key } = told;
  const close = (): void => {
    closePcNotice(key);
    setTold(null);
  };
  const notMine = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setRefused(null);
    let action: "not_me" | "remove" = "not_me";
    try {
      const bound = indexedAccountService.forSignIn(session);
      try { await bound.notMe(session.provider); } catch (error) {
        // past its 24 hours (a notice left open), the way in is taken out the ordinary way
        if (!(error instanceof AccountServiceError && error.status === 409 && error.code === "settled")) throw error;
        action = "remove";
        await bound.removeIdentity(session.provider);
      }
    } catch (error) {
      // the way in's own sign-in ends with it: one already gone took it out
      if (!(error instanceof SignedOutError)) {
        if (!(error instanceof Error)) throw error;
        setRefused(methodRefusalText(t, { action, provider: session.provider, code: error instanceof AccountServiceError ? error.code : "failed" }, locale));
        return;
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
    close();
    const shell = shellAccountActions();
    // the account this notice named: a sign-in to another one stored meanwhile is not the one ended
    if (shell !== null) shell.signOut(shownOf(pageAccountList(), session.account));
    else await indexedAccountService.forSignIn(session).signOut();
  };
  const madeWith = joined.methods.find((provider) => provider !== session.provider) ?? joined.methods[0];
  if (madeWith === undefined) return null;
  const provider = PROVIDER_NAMES[madeWith];
  return (
    <div className="update-notice is-paired device-notice" role="status" data-testid="joined-notice">
      <UserRound aria-hidden="true" />
      <span className="device-notice-text">
        <span>{joined.emailHint === null ? t("Signed in to the account made with {provider}", { provider })
          : t("Signed in to the account made with {provider} ({email})", { provider, email: joined.emailHint })}</span>
        {refused !== null && <span className="account-error" role="alert">{refused}</span>}
      </span>
      <div className="device-paired-actions">
        <button type="button" className="btn" data-action="not-my-account" disabled={sending} onClick={() => { void notMine(); }}>{t("Not my account")}</button>
        <button type="button" className="icon-button update-notice-dismiss" data-action="close" aria-label={t("Close")} title={t("Close")} onClick={close}><X aria-hidden="true" /></button>
      </div>
    </div>
  );
}
