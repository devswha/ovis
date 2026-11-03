import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { ProviderUsage } from "../../shared/protocol.ts";
import { removeUsageAccount } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { usageName } from "../lib/usage.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** Forget a list entry, not a CLI credential: the same account's next explicit sign-in restores it. */
export function UsageRemoveAccount({ usage }: { readonly usage: ProviderUsage }) {
  const t = useT();
  const [confirm, setConfirm] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const name = usageName(usage);
  return <>
    <button ref={trigger} type="button" className="icon-button" aria-label={t("Remove {name}", { name })} title={t("Remove {name}", { name })} onClick={() => setConfirm(true)}>
      <Trash2 aria-hidden="true" />
    </button>
    {confirm && <ConfirmDialog title={t("Remove {name}?", { name })}
      body={t("Remove this account from Ovis? Its CLI sign-in and credentials stay on this PC.")}
      confirmLabel={t("Remove")} onClose={() => setConfirm(false)} onConfirm={async () => {
        const parent = trigger.current?.closest<HTMLElement>("[data-section]");
        await removeUsageAccount(usage.key);
        setConfirm(false);
        window.dispatchEvent(new Event("herdr-usage-changed"));
        parent?.focus();
      }} />}
  </>;
}
