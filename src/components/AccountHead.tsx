import { useContext } from "react";
import { LogOut } from "lucide-react";

import type { HostedSignIn } from "../lib/account/hostedSignIn.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { PROVIDER_NAMES, ProviderMark } from "./AccountPcs.tsx";
import type { RowMenuItem } from "./RowMenu.tsx";
import { SettingsGroup, SettingsQuery, SettingsRow } from "./SettingsControls.tsx";

/** The account group's first row: who is signed in, with its Sign out (a settings row of its own while a search runs). */
export function AccountHead({ provider, plan = null, title, onSignOut }: { provider: AccountProvider; plan?: string | null; title?: string; onSignOut: () => void }) {
  const t = useT();
  const searching = useContext(SettingsQuery).length > 0;
  const name = PROVIDER_NAMES[provider];
  if (searching) {
    return (
      <SettingsRow label={t("Signed in with {provider}", { provider: name })} description={plan ?? undefined} keywords={t("Sign out")}>
        <button type="button" className="btn" onClick={onSignOut}>{t("Sign out of {provider}", { provider: name })}</button>
      </SettingsRow>
    );
  }
  return (
    <div className="settings-row account-head">
      <span className="account-who" title={title}>
        <ProviderMark provider={provider} />
        <span className="settings-label" aria-hidden="true">{name}</span>
        <span className="visually-hidden">{t("Signed in with {provider}", { provider: name })}</span>
        {plan !== null && <span className="account-plan">{plan}</span>}
      </span>
      <button type="button" className="btn account-head-btn" aria-label={t("Sign out of {provider}", { provider: name })} onClick={onSignOut}>{t("Sign out")}</button>
    </div>
  );
}

/** Settings → Devices and PCs on a PC page the hosted app opened: the hosted sign-in, while there is one. */
export function HostedAccountGroup({ signIn }: { signIn: HostedSignIn | null }) {
  const t = useT();
  if (signIn === null) return null;
  return (
    <SettingsGroup title={t("Account")} section="account">
      <AccountHead provider={signIn.provider} onSignOut={signIn.signOut} />
    </SettingsGroup>
  );
}

/** More's Sign out on a phone, for the hosted sign-in: none while signed out or off the hosted app. */
export function hostedSignOutItems(signIn: HostedSignIn | null, t: Translate): RowMenuItem[] {
  return signIn === null ? [] : [{ id: "sign-out", label: t("Sign out"), icon: LogOut, divider: true, run: signIn.signOut }];
}
