import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from "react";
import { Check, Plus, X } from "lucide-react";

import type { HostedSignIn } from "../lib/account/hostedSignIn.ts";
import { availableFrom, settlingUntil, useSettlingDeadline } from "../lib/account/methodSettling.ts";
import type { AccountIdentity, AccountIdentityChange, AccountIdentityList } from "../lib/account/service.ts";
import type { AccountProvider, AccountSession } from "../lib/account/store.ts";
import { ExternalLink } from "../lib/externalLink.ts";
import { useLocale, useT, type Translate } from "../lib/i18n.ts";
import { PROVIDER_NAMES, ProviderMark } from "./AccountPcs.tsx";

const IN_USE_HELP = "https://github.com/devswha/ovis/blob/main/docs/guide.md#a-sign-in-method-that-belongs-to-another-account";
const RECENT_CHANGES = 3;

function changeText(t: Translate, kind: AccountIdentityChange["kind"], provider: string, how: AccountIdentityChange["how"]): string {
  switch (kind) {
    case "add": return how === "email" ? t("{provider} added by email", { provider }) : t("{provider} added", { provider });
    case "remove": return how === "not_me" ? t("{provider} removed with Not me", { provider }) : t("{provider} removed", { provider });
    case "merge_in": return t("{provider} merged in", { provider });
    default: return kind satisfies never;
  }
}

function changeLine(t: Translate, locale: string, { kind, provider, at, device_no, how }: AccountIdentityChange): string {
  const day = new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric" });
  return [day, changeText(t, kind, PROVIDER_NAMES[provider], how), ...(device_no === null ? [] : [t("Device {n}", { n: device_no })])].join(" · ");
}

/** The link to the steps for a provider account that another Ovis account holds, after the line that says so. */
export function InUseSteps() {
  const t = useT();
  return <ExternalLink kind="link" className="settings-link" href={IN_USE_HELP}>{t("See how")}</ExternalLink>;
}

/**
 * The account's ways to sign in on one row, the same on every surface of Manage account: a chip for each, Remove on
 * all but the only one and the one this device signed in with (`current`: removing it would end this sign-in), and Add
 * for each of `offered` the account lacks. Under the row, one card per way in the service added because it has the
 * account's email, with Not me while it can be taken back; what a change said (`children`); then the latest changes.
 * While `current` itself was just added so, the service refuses every change to the ways in: none is offered, and
 * the row says from when.
 */
export function AccountMethods({ methods, current, offered, history, hint, onAdd, onRemove, onNotMe, children }: {
  readonly methods: readonly AccountIdentity[];
  readonly current: AccountProvider;
  /** the providers a way in can be added with here: the account service's, or none on a page that adds none */
  readonly offered: readonly AccountProvider[];
  /** the changes to the ways in, newest first */
  readonly history: readonly AccountIdentityChange[];
  /** where a way in is added, said on a page that adds none */
  readonly hint?: string | undefined;
  readonly onAdd: (provider: AccountProvider) => void;
  readonly onRemove: (provider: AccountProvider) => void;
  readonly onNotMe?: ((provider: AccountProvider) => void) | undefined;
  readonly children?: ReactNode;
}) {
  const t = useT();
  const locale = useLocale();
  const changesId = useId();
  const now = Date.now();
  const settling = settlingUntil(methods, current, now);
  const unlinked = settling !== null ? [] : offered.filter((provider) => !methods.some((method) => method.provider === provider));
  const joined = settling !== null ? [] : methods.filter((method) => method.provider !== current && method.how !== undefined
    && method.deniable_until !== undefined && Date.parse(method.deniable_until) > now);
  const recent = history.slice(0, RECENT_CHANGES);
  return (
    <div className="settings-item account-methods">
      <div className="account-method-row" title={hint}>
        <span className="settings-label">{t("Ways to sign in")}{hint !== undefined && <span className="visually-hidden"> {hint}</span>}</span>
        <ul className="account-method-list">
          {methods.map((method) => {
            const name = PROVIDER_NAMES[method.provider];
            return (
              <li key={method.provider} className="account-method account-chip" data-provider={method.provider} title={name}>
                <ProviderMark provider={method.provider} />
                <span className="visually-hidden">{t("{provider}, connected", { provider: name })}</span>
                <Check className="account-chip-icon" aria-hidden="true" />
                {methods.length > 1 && method.provider !== current && settling === null && (
                  <button type="button" className="account-chip-remove" title={t("Remove {provider}", { provider: name })} onClick={() => onRemove(method.provider)}>
                    <X aria-hidden="true" /><span className="visually-hidden">{t("Remove {provider}", { provider: name })}</span>
                  </button>
                )}
              </li>
            );
          })}
          {unlinked.map((provider) => (
            <li key={provider}>
              <button type="button" className="account-chip account-chip-add" data-provider={provider} title={t("Add {provider}", { provider: PROVIDER_NAMES[provider] })} onClick={() => onAdd(provider)}>
                <Plus className="account-chip-icon" aria-hidden="true" /><ProviderMark provider={provider} />
                <span className="visually-hidden">{t("Add {provider}", { provider: PROVIDER_NAMES[provider] })}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {settling !== null && <p className="settings-description" data-testid="account-method-settling">{availableFrom(t, locale, settling)}</p>}
      {joined.map(({ provider }) => (
        <div key={provider} className="account-reauth" data-testid="account-method-attached" data-provider={provider}>
          <p className="settings-description">{t("{provider} was added to this account because it has the same email", { provider: PROVIDER_NAMES[provider] })}</p>
          {onNotMe !== undefined
            ? <button type="button" className="btn" data-action="not-me" onClick={() => onNotMe(provider)}>{t("Not me")}</button>
            : <p className="settings-description">{t("Use Not me in the Ovis app or at app.ovis.sh.")}</p>}
        </div>
      ))}
      {children}
      {recent.length > 0 && (
        <div className="account-manage-part" data-testid="account-method-history">
          <p className="account-manage-h" id={changesId}>{t("Recent changes")}</p>
          <ul className="account-manage-list account-plan" aria-labelledby={changesId}>
            {recent.map((change, index) => <li key={index}>{changeLine(t, locale, change)}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

type MethodsShell = Pick<HostedSignIn, "provider" | "account" | "session" | "methods" | "offered" | "addMethod" | "removeMethod" | "notMe" | "methodsChange" | "signInAgainForMethod" | "freshSignIn">;
type MethodAction = "add" | "remove" | "not_me";

interface Refusal {
  readonly action: MethodAction;
  readonly provider: AccountProvider;
  readonly code: string;
  /** for `method_settling`: when this sign-in's own way in has settled (ISO) */
  readonly until?: string | undefined;
}

/**
 * The outcomes a sheet has taken up. The shell keeps its last one for as long as the app runs, so each is said by the
 * sheet that first reads it: one opened later, or for another account, repeats none.
 */
const taken = new WeakSet<object>();

function untaken(shell: MethodsShell) {
  const outcome = shell.methodsChange?.();
  if (outcome?.account !== shell.account || taken.has(outcome)) return null;
  taken.add(outcome);
  return outcome;
}

export function methodRefusalText(t: Translate, { action, provider, code, until }: Refusal, locale = "en-US"): string {
  const name = PROVIDER_NAMES[provider];
  if (code === "method_settling" && until !== undefined) return availableFrom(t, locale, until);
  switch (code) {
    case "identity_in_use":
    case "in_use": return t("This {provider} account is linked to another Ovis account. Take {provider} off that account first, then you can add it here.", { provider: name });
    case "two_step_required": return t("Turn on two-step sign-in before adding another method.");
    case "two_step_unknown": return t("Ovis could not confirm two-step sign-in. Check it with your sign-in provider.");
    case "merge_open": return t("Finish or cancel the account merge before adding another sign-in method.");
    case "reauth_required": return t("Sign in again before adding another method.");
    case "identity_exists": return t("Your account already signs in with {provider}.", { provider: name });
    case "last_identity": return t("Add another way to sign in before removing this one.");
    case "denied": return t("{provider} refused the sign-in.", { provider: name });
    // a sign-in made with a code takes back only its own way in
    case "web_sign_in_required": return t("Use Not me in the Ovis app or at app.ovis.sh.");
    default: return action === "add" ? t("The sign-in did not finish. Try again.") : t("The sign-in method could not be removed. Try again.");
  }
}

/**
 * The hosted sign-in's ways in, first in its Manage account: read from the shell, changed through it, and read again
 * after each change. A change the shell refused is said under the row. In a browser an Add leaves for the provider's
 * pages, so what came of it is said by the sheet opened after the return.
 */
export function HostedAccountMethods({ signIn, onSettling }: {
  readonly signIn: MethodsShell;
  /** when this sign-in's own way in settles, while it settles (null otherwise): what it may not do meanwhile is not offered */
  readonly onSettling?: (until: string | null) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [list, setList] = useState<AccountIdentityList | "failed" | null>(null);
  const [offered, setOffered] = useState<readonly AccountProvider[]>([]);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const changing = useRef(false);
  const reads = useRef(0);

  const read = async (shown = signIn.session): Promise<void> => {
    if (signIn.methods === undefined) return;
    const mine = ++reads.current;
    try {
      const now = await signIn.methods(shown);
      if (reads.current === mine) setList(now);
    } catch (error) {
      console.warn("Ovis: the ways to sign in could not be read", error instanceof Error ? error.name : error);
      // a read again that fails keeps what the last one said: a way in still settling stays so until one says otherwise
      if (reads.current === mine) setList((shown) => shown === null ? "failed" : shown);
    }
  };

  const opened = useEffectEvent((): void => {
    const back = untaken(signIn);
    if (back !== null && back.error !== null) setRefusal({ action: "add", provider: back.provider, code: back.error });
    void read();
    void signIn.offered?.().then(setOffered, (error: unknown) => console.warn("Ovis: the account service's sign-ins could not be read", error instanceof Error ? error.name : error));
  });
  useEffect(() => {
    opened();
    return () => { reads.current++; };
  }, [signIn.session.sign_in_id]);
  // the account service rings every device of the account when a way in is added by its email or taken back: the ring
  // brings the app to the front, where the ways in are read again
  const readAgain = useEffectEvent((): void => { if (document.visibilityState !== "hidden") void read(); });
  useEffect(() => {
    window.addEventListener("focus", readAgain);
    document.addEventListener("visibilitychange", readAgain);
    return () => {
      window.removeEventListener("focus", readAgain);
      document.removeEventListener("visibilitychange", readAgain);
    };
  }, []);

  const change = (action: MethodAction, provider: AccountProvider, shown: AccountSession = signIn.session): void => {
    const run = action === "add" ? signIn.addMethod : action === "remove" ? signIn.removeMethod : signIn.notMe;
    if (run === undefined || changing.current) return;
    changing.current = true;
    setRefusal(null);
    void run(provider, shown).then(() => {
      // none to take up: the change went through, or the page is leaving for the provider, whose return says the rest
      const outcome = untaken(signIn);
      if (outcome !== null && outcome.error !== null) setRefusal({ action, provider: outcome.provider, code: outcome.error, until: outcome.until });
      // A successful phone Add installed a new sign-in; its session event reads the new methods.
      if (outcome?.error !== "signed_out" && (action !== "add" || outcome?.error != null)) return read(shown);
    }).catch((error: unknown) => {
      console.warn("Ovis: the way to sign in was not changed", error instanceof Error ? error.name : error);
      setRefusal({ action, provider, code: "failed" });
    }).finally(() => { changing.current = false; });
  };

  const signInAgain = (waiting: Refusal): void => {
    const fresh = signIn.freshSignIn;
    // a browser signs in by leaving the page: the change is asked again after the return
    const from = signIn.session;
    const again = fresh === undefined ? signIn.signInAgainForMethod?.(from, waiting.action === "add" ? waiting.provider : undefined)
      : fresh(from, () => {}).then((renewed) => {
        if (renewed?.account === from.account) change(waiting.action, waiting.provider, renewed);
      });
    void again?.catch((error: unknown) => console.warn("Ovis: the sign-in again did not finish", error instanceof Error ? error.name : error));
  };

  useSettlingDeadline(list === null || list === "failed" ? undefined : list.identities);
  const settling = list === null || list === "failed" ? null : settlingUntil(list.identities, signIn.provider, Date.now());
  useEffect(() => { onSettling?.(settling); }, [onSettling, settling]);

  if (signIn.methods === undefined || list === "failed") return null;
  return (
    <AccountMethods methods={list?.identities ?? []} history={list?.history ?? []} current={signIn.provider}
      // before the account's own ways in are read, every provider would look like one it lacks
      offered={list === null ? [] : offered}
      onAdd={(provider) => change("add", provider)} onRemove={(provider) => change("remove", provider)}
      onNotMe={signIn.notMe === undefined ? undefined : (provider) => change("not_me", provider)}>
      {refusal?.code === "reauth_required" ? (
        <div className="account-reauth" role="alert">
          <p className="settings-description">{t("To change how you sign in, sign in again with {provider} first.", { provider: PROVIDER_NAMES[signIn.provider] })}</p>
          {(signIn.freshSignIn !== undefined || signIn.signInAgainForMethod !== undefined) && <button type="button" className="btn btn-primary" onClick={() => signInAgain(refusal)}>{t("Sign in again")}</button>}
        </div>
      ) : refusal !== null && (
        <p className="settings-condition" role="alert">{methodRefusalText(t, refusal, locale)}{(refusal.code === "in_use" || refusal.code === "identity_in_use") && <> <InUseSteps /></>}</p>
      )}
    </AccountMethods>
  );
}
