import { useContext, useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LogOut, UserRound, X } from "lucide-react";

import type { HostedSignIn } from "../lib/account/hostedSignIn.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { AccountManageLists } from "./AccountManage.tsx";
import { PROVIDER_NAMES, ProviderMark } from "./AccountPcs.tsx";
import type { RowMenuItem } from "./RowMenu.tsx";
import { SettingsGroup, SettingsQuery, SettingsRow } from "./SettingsControls.tsx";

/**
 * The account group's one line: who is signed in, Manage account (where the page has it) and Sign out; a settings row of
 * its own while a search runs, which also names the plan.
 */
export function AccountHead({ provider, plan = null, onManage, onSignOut }: { provider: AccountProvider; plan?: string | null; onManage?: () => void; onSignOut: () => void }) {
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
      <span className="account-who">
        <ProviderMark provider={provider} />
        <span className="settings-label">{t("Signed in with {provider}", { provider: name })}</span>
      </span>
      <span className="account-head-actions">
        {onManage !== undefined && <button type="button" className="btn account-head-btn" data-action="manage-account" onClick={onManage}>{t("Manage account")}</button>}
        <button type="button" className="btn account-head-btn" aria-label={t("Sign out of {provider}", { provider: name })} onClick={onSignOut}>{t("Sign out")}</button>
      </span>
    </div>
  );
}

/** Manage account: the account's ways in, its plan and Delete account, in a sheet over Settings. */
export function ManageAccountSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const t = useT();
  const id = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // a question over the sheet (an alert dialog, a native modal) takes its own Escape
      if (event.key !== "Escape" || event.isComposing || nativeModalOver(surface.current) || document.querySelector('[role="alertdialog"]') !== null) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, surface]);
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal account-manage-sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} data-testid="manage-account">
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Manage account")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body account-manage-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Settings → Devices and PCs on a PC page the hosted app opened: the hosted sign-in, while there is one, and its
 * Manage account (the account's devices and PCs, then Delete account, asked twice).
 */
export function HostedAccountGroup({ signIn, watching = false }: { signIn: HostedSignIn | null; watching?: boolean }) {
  const t = useT();
  const [managing, setManaging] = useState(false);
  const [deleting, setDeleting] = useState<"asked" | "out" | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // what this device's leave said of the PCs that kept it: the sheet keeps it after the sign-in it left is gone
  const [leaveNote, setLeaveNote] = useState<string | null>(null);
  if (signIn === null && leaveNote === null) return null;
  const close = (): void => { setManaging(false); setDeleting(null); setDeleteError(null); setLeaveNote(null); };
  const leave = async (from: HostedSignIn): Promise<void> => {
    const { left, message } = await from.leave();
    if (!left && message !== null) throw new Error(message);
    if (message === null) close(); else setLeaveNote(message);
  };
  const remove = (): void => {
    if (deleting !== "asked") { setDeleting("asked"); setDeleteError(null); return; }
    setDeleting("out");
    void signIn?.deleteAccount().then(setDeleteError, () => setDeleteError(t("The account could not be deleted. Try again."))).finally(() => setDeleting(null));
  };
  return (
    <SettingsGroup section="account">
      {signIn !== null && <AccountHead provider={signIn.provider} onSignOut={signIn.signOut} onManage={() => setManaging(true)} />}
      {managing && (
        <ManageAccountSheet onClose={close}>
          {signIn !== null && <AccountManageLists key={signIn.account} account={signIn.account} watching={watching} onLeave={() => leave(signIn)} />}
          {leaveNote !== null && <p className="settings-condition" role="alert">{leaveNote}</p>}
          {signIn !== null && <div className="settings-item account-delete">
            {deleting === "asked" && <p className="settings-description" role="status" data-testid="delete-account-says">{t("This deletes your Ovis account for good: your sign-in methods, your list of PCs and your plan. It cannot be undone. Devices stay paired with your PCs until you revoke them on each PC. A subscription that still renews has to be cancelled first.")}</p>}
            <div className="account-delete-actions">
              <button type="button" className={deleting === "asked" ? "btn btn-danger" : "account-delete-link"} data-action="delete-account" data-confirm={deleting === "asked" ? "delete-account" : undefined}
                disabled={deleting === "out"} aria-busy={deleting === "out" ? "true" : undefined} onClick={remove}>{deleting === "asked" ? t("Delete account for good?") : t("Delete account")}</button>
              {deleting === "asked" && <button type="button" className="btn btn-ghost" onClick={() => setDeleting(null)}>{t("Cancel")}</button>}
            </div>
            {deleteError !== null && <p className="settings-condition" role="alert">{deleteError}</p>}
          </div>}
        </ManageAccountSheet>
      )}
    </SettingsGroup>
  );
}

/**
 * More's account on a phone, for the hosted sign-in: who is signed in (it opens the account in Settings, `onAccount`)
 * and Sign out. None while signed out or off the hosted app.
 */
export function hostedAccountItems(signIn: HostedSignIn | null, t: Translate, onAccount: () => void): RowMenuItem[] {
  if (signIn === null) return [];
  return [
    { id: "account", label: t("Signed in with {provider}", { provider: PROVIDER_NAMES[signIn.provider] }), icon: UserRound, divider: true, run: onAccount },
    { id: "sign-out", label: t("Sign out"), icon: LogOut, run: signIn.signOut },
  ];
}
