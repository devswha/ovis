import { Clock, X } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { showEnrollmentNotice, useEnrollmentNotice } from "../lib/relay/enrollmentNotice.ts";

/**
 * What the open PC says about its account enrollment while it is not finished, fed by the enrollment that runs
 * in this page (lib/relay/enrollmentNotice.ts). `waiting`: the seconds left of the wait the account service asked for
 * before another PC is asked again (the feeder counts them down). `failed`: it stopped, and `reason` is the plain
 * line that says why, in the person's language.
 */
export type EnrollmentNoticeState = { readonly kind: "waiting"; readonly seconds: number } | { readonly kind: "failed"; readonly reason: string };

/**
 * One line over the open PC; it can be dismissed only once the enrollment is done (failed), never while it waits. What
 * a program reads of it: `data-enrollment-notice` on the line, `data-kind`, and `data-seconds` (waiting) or `data-reason`
 * (failed, the reason as given); the dismiss control is `data-action="dismiss-enrollment-notice"`.
 */
export function EnrollmentNotice({ state, onDismiss }: { readonly state: EnrollmentNoticeState; readonly onDismiss: () => void }) {
  const t = useT();
  switch (state.kind) {
    case "waiting": return (
      <div className="update-notice is-paired" role="status" data-enrollment-notice="" data-kind="waiting" data-seconds={state.seconds}>
        <Clock aria-hidden="true" />
        <span>{t("Adding this PC to your account: the account service is busy. Trying again in {seconds} s…", { seconds: state.seconds })}</span>
      </div>
    );
    case "failed": return (
      <div className="update-notice is-paired" role="status" data-enrollment-notice="" data-kind="failed" data-reason={state.reason}>
        <Clock aria-hidden="true" />
        <span>{state.reason}</span>
        <div className="device-paired-actions">
          <button type="button" className="icon-button update-notice-dismiss" data-action="dismiss-enrollment-notice" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={onDismiss}><X /></button>
        </div>
      </div>
    );
  }
}

/** The notice the open PC shows (App.tsx): whatever this page's enrollment said last, until it is over. */
export function OpenPcEnrollmentNotice() {
  const state = useEnrollmentNotice();
  return state === null ? null : <EnrollmentNotice state={state} onDismiss={() => showEnrollmentNotice(null)} />;
}
