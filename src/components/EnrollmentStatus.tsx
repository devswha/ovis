import { useT } from "../lib/i18n.ts";
import type { EnrollmentState } from "../lib/relay/device.ts";

/** Account work never gates opening an already paired PC. */
export function EnrollmentStatus({ state, retry }: { readonly state: EnrollmentState | "local" | undefined; readonly retry?: () => void }) {
  const t = useT();
  switch (state) {
    case "pending": return <div className="relay-shell-wait" role="status"><span className="boot-spinner" aria-hidden="true" /><p className="relay-shell-detail">{t("Adding it to your account…")}</p></div>;
    case "complete": return <p className="relay-shell-detail" role="status">{t("Every device of your account can open it")}</p>;
    case "failed": return <div role="status"><p className="relay-shell-detail">{t("Ready · not in the account yet")}</p>{retry && <button type="button" className="btn" data-action="retry-enrollment" onClick={retry}>{t("Try again")}</button>}</div>;
    case "local": case undefined: return null;
  }
}
