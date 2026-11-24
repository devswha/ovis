import { useState, type ReactNode } from "react";

import { shellAccountActions, type FreshSignIn } from "../lib/account/hostedSignIn.ts";
import { pageListPc } from "../lib/account/listPcs.ts";
import { removeListPc } from "../lib/account/listRemove.ts";
import { ACCOUNT_PCS_CHANGED_EVENT } from "../lib/account/myPcs.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { AccountServiceError, listingChanged, type AccountService } from "../lib/account/service.ts";
import type { AccountSession } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { ExternalLink } from "../lib/externalLink.ts";
import { useSignInAgainHere } from "./AccountSection.tsx";

/** PCR-1: the account service removes a PC only for this device's own sign-in made in the last ten minutes. */
type Refusal = "reauth_required" | "own_sign_in_required";

const refusalOf = (error: unknown): Refusal | null =>
  error instanceof AccountServiceError && (error.code === "reauth_required" || error.code === "own_sign_in_required") ? error.code : null;

/** The list did not take the removal of a PC (listWrite.ts, WriteRefusal): the PC is in the account as before. */
export class ListPcRemovalError extends Error {
  constructor(readonly why: string) {
    super(`The PC was not removed from the account's list (${why})`);
    this.name = "ListPcRemovalError";
  }
}

/** What to say of a removal that failed: what the list said where that tells the person more, the surface's own words otherwise. */
export function pcRemovalFailure(error: unknown, t: ReturnType<typeof useT>, otherwise: string): string {
  return error instanceof ListPcRemovalError && error.why === "stopped" ? t("The account service cannot change the list right now.") : otherwise;
}

type Asked = {
  readonly session: AccountSession;
  readonly serverId: string;
  readonly listingId: string | undefined;
  readonly refusal: Refusal;
  readonly step: "offered" | "signing-in" | "failed";
  readonly link: string | null;
};

/**
 * A PC's removal from the account. `remove` removes it as `session` and then tells `removed`; when the service wants a
 * fresh own sign-in first it resolves false, and `prompt` says so with Sign in again. That press signs in again in place
 * (the desktop app, the PC's own window, the phone app) and removes the same PC with the fresh sign-in: the removal was
 * already asked for. Where the page signs in only by leaving (the hosted app in a browser), Sign in again leaves, and the
 * PC is removed by a press after the return. A removal naming the listing its card showed (`listingId`, account#67) that
 * the service refuses as `listing_changed` removed nothing and is no failure: it resolves false and the account's PCs are
 * read again, so the card shows what is there now. Any other failure throws.
 *
 * A PC that this device's list of the account holds leaves by an entry of that list, which this device signs
 * (listRemove.ts): the account service removes nothing for it, and asks for no sign-in.
 */
export function usePcRemoval(service: Pick<AccountService, "forSignIn">, removed: (serverId: string, how: "list" | "directory") => void | Promise<void>): {
  readonly remove: (session: AccountSession, serverId: string, listingId?: string) => Promise<boolean>;
  readonly prompt: ReactNode;
  /** the PC \`prompt\` speaks of, for a surface that draws one row per PC; null with no prompt */
  readonly promptFor: string | null;
} {
  const t = useT();
  const here = useSignInAgainHere();
  const [asked, setAsked] = useState<Asked | null>(null);
  const shell = shellAccountActions();
  const fresh: FreshSignIn | undefined = shell !== null ? shell.freshSignIn
    : here === undefined ? undefined : (from, blocked) => here(from, { signal: new AbortController().signal, wanted: () => true, blocked });
  const leaving = shell?.signInAgain;

  const remove = async (session: AccountSession, serverId: string, listingId?: string): Promise<boolean> => {
    setAsked(null);
    const list = pageAccountList();
    const endpoint = list === null ? null : pageListPc(session.account, serverId);
    const { status } = list?.view() ?? { status: null };
    if (list !== null && endpoint !== null && status?.at === "following") {
      // for the account and the list whose row the person pressed: another tab's sign-in changes neither under it
      const outcome = await removeListPc(list, endpoint, { expect: { account: session.account, list: status.list } });
      if (!outcome.removed) throw new ListPcRemovalError(outcome.why);
      await removed(serverId, "list");
      return true;
    }
    try { await service.forSignIn(session).deletePc(serverId, listingId); }
    catch (error) {
      if (listingChanged(error)) { window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT)); return false; }
      const refusal = refusalOf(error);
      if (refusal === null) throw error;
      setAsked({ session, serverId, listingId, refusal, step: "offered", link: null });
      return false;
    }
    await removed(serverId, "directory");
    return true;
  };

  const signInAgain = (shown: Asked): void => {
    if (fresh === undefined) { leaving?.(shown.session.provider); return; }
    setAsked({ ...shown, step: "signing-in" });
    const still = (now: Asked | null): boolean => now?.session === shown.session && now.serverId === shown.serverId;
    fresh(shown.session, (link) => setAsked((now) => still(now) ? { ...now!, link } : now)).then(async (again) => {
      if (again === null) { setAsked((now) => still(now) ? { ...shown, step: "failed" } : now); return; }
      await remove(again, shown.serverId, shown.listingId);
    }).catch((error: unknown) => {
      console.warn("Ovis: the PC was not removed after signing in again", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
      setAsked((now) => still(now) || now === null ? { ...shown, step: "failed" } : now);
    });
  };

  const offers = asked !== null && (fresh !== undefined || leaving !== undefined);
  const prompt = asked === null ? null : (
    <span className="pc-removal-sign-in" data-pc-removal={asked.serverId}>
      <span className="account-error" role="alert">
        {asked.step === "failed" ? t("The PC could not be removed. Try again.")
          : asked.step === "signing-in" ? t("Finish signing in in your browser.")
          : asked.refusal === "reauth_required" ? t("Sign in again to remove it: your sign-in is more than ten minutes old.")
          : t("Sign in on this device to remove it.")}
      </span>
      {offers && asked.step !== "signing-in" && <button type="button" className="btn" onClick={() => signInAgain(asked)}>{t("Sign in again")}</button>}
      {asked.step === "signing-in" && asked.link !== null && <ExternalLink kind="sign-in" className="btn" href={asked.link}>{t("Open the sign-in page")}</ExternalLink>}
    </span>
  );
  return { remove, prompt, promptFor: asked?.serverId ?? null };
}
