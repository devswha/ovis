import { useT } from "../lib/i18n.ts";
import { SettingsRow } from "./SettingsControls.tsx";

/**
 * Settings → Devices and PCs → More settings → Fleet: the Fleet screen's entry, only while the server's health says
 * `fleet_preview` (OVIS_PREVIEW=fleet, server/preview.ts). The sidebar's Fleet machines caption keeps its own rule.
 */
export function FleetRow({ preview, onOpen }: { preview: boolean; onOpen: () => void }) {
  const t = useT();
  if (!preview) return null;
  return (
    <SettingsRow label={t("Fleet")} description={t("Machines that joined this PC with an invite: confirm new ones, see why one cannot be reached, remove one.")} keywords={t("fleet machines invites enrol confirm")}>
      <button type="button" className="btn" onClick={onOpen}>{t("Open fleet")}</button>
    </SettingsRow>
  );
}
