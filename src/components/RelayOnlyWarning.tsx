import { TriangleAlert } from "lucide-react";

import { useT } from "../lib/i18n.ts";

/**
 * Security-triage's CONDITIONAL GO 4 (device table T70): recovery from a stolen older device happens at this PC, so a
 * PC reachable only through the relay needs SSH, a console or a screen kept working. Only while the account opens
 * every PC (account-opens-all/1); nothing changes with the release off.
 */
export function RelayOnlyWarning({ opensAll }: { opensAll: boolean }) {
  const t = useT();
  if (!opensAll) return null;
  return <p className="setup-note"><TriangleAlert aria-hidden="true" />{t("Keep SSH or a screen working on this PC: reached only through the relay, one stolen older device could lock you out of it.")}</p>;
}
