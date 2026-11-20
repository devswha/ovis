import { useEffect, useRef, useState } from "react";
import { holdingSessionStore, installSignInAgain } from "../lib/account/deleteAccount.ts";
import { ownWindowSignIn } from "../lib/account/ownWindow.ts";
import { indexedAccountStore, type AccountSession } from "../lib/account/store.ts";
import { ExternalLink } from "../lib/externalLink.ts";
import { useT } from "../lib/i18n.ts";

/** Refresh only the own-window sign-in that attempted this claim; never replace another tab's sign-in. */
export function FirstMemberSignIn({ session, redirect, onSignedIn }: {
  session: AccountSession; redirect: string; onSignedIn: (fresh: AccountSession) => void;
}) {
  const t = useT();
  const [state, setState] = useState<"offer" | "waiting" | "failed">("offer");
  const [link, setLink] = useState<string | null>(null);
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  const signIn = async () => {
    if (running.current !== null) return;
    const controller = new AbortController();
    running.current = controller;
    const live = () => !controller.signal.aborted;
    setLink(null);
    setState("waiting");
    try {
      const fresh = await ownWindowSignIn(session.provider, { service: session.service, redirect, signal: controller.signal,
        store: holdingSessionStore(indexedAccountStore), blocked: url => { if (live()) setLink(url); } });
      if (!live()) return;
      if (fresh.account !== session.account || fresh.service !== session.service || !await installSignInAgain(indexedAccountStore, session, fresh, live)) {
        if (live()) setState("failed");
        return;
      }
      if (live()) onSignedIn(fresh);
    } catch {
      if (live()) setState("failed");
    } finally { if (running.current === controller) running.current = null; }
  };
  if (state === "waiting") return <>
    <p className="settings-description" role="status">{t("Finish signing in in your browser.")}</p>
    {link !== null && <ExternalLink kind="sign-in" className="btn btn-primary" href={link}>{t("Open the sign-in page")}</ExternalLink>}
    <button type="button" className="btn" onClick={() => { running.current?.abort(); running.current = null; setState("offer"); }}>{t("Cancel")}</button>
  </>;
  return <>
    <p className="settings-description">{t("This PC has its first member, but setup didn't finish. Try again.")}</p>
    <button type="button" className="btn btn-primary" onClick={signIn}>{t("Sign in again")}</button>
    {state === "failed" && <p className="settings-condition" role="alert">{t("The sign-in did not finish. Try again.")}</p>}
  </>;
}
