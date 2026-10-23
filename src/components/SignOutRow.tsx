import { useState } from "react";

import { useT, type Translate } from "../lib/i18n.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { SettingsRow } from "./SettingsControls.tsx";

/**
 * What Sign out says of the way back in, which depends on how the browser got in: a token or a
 * pairing code, or, for a visitor Portal's own sign-in let in (`viaPortal`), Portal's sign-in again.
 */
export function wayBackIn(t: Translate, viaPortal: boolean): { row: string; confirm: string } {
  return viaPortal
    ? { row: t("Forget this browser's sign-in. Getting back in means signing in through Portal again."), confirm: t("Getting back in means signing in through Portal again.") }
    : { row: t("Forget this browser's sign-in. Getting back in takes the access token or a pairing code."), confirm: t("Getting back in takes the access token, or a pairing code from the PC: Settings → Phone & devices there, or the pair command in its terminal.") };
}

/** Settings → Phone & devices → Devices → Sign out: forget this browser's sign-in, after asking once. */
export function SignOutRow({ viaPortal, onSignOut }: { viaPortal: boolean; onSignOut: () => Promise<void> }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const words = wayBackIn(t, viaPortal);
  return (
    <>
      <SettingsRow label={t("Sign out")} description={words.row}>
        <button type="button" className="btn" onClick={() => setConfirming(true)}>{t("Sign out")}</button>
      </SettingsRow>
      {confirming && <ConfirmDialog title={t("Sign out of this browser?")} body={words.confirm} confirmLabel={t("Sign out")} onClose={() => setConfirming(false)} onConfirm={onSignOut} />}
    </>
  );
}
