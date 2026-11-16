import type { PullRequestChecks, PullRequestEntry } from "../../../shared/protocol.ts";
import type { Translate } from "../../lib/i18n.ts";

/** Shared by the repository dialog and the GitHub inbox. */
export function pullRequestWords(t: Translate) {
  const checks: Record<PullRequestChecks, string | null> = { passing: t("Checks passing"), failing: t("Checks failing"), pending: t("Checks running"), none: null };
  const reviews: Record<PullRequestEntry["review"], string | null> = { approved: t("Approved"), changes_requested: t("Changes requested"), review_required: t("Review required"), none: null };
  return { checks, reviews };
}
