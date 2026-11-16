import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n.ts";
import { useSettings } from "../../lib/settings.ts";

/** Inbox chrome only: keep upstream when off, and no way back from a phone's inbox home. */
export function ForkInboxBack({ wide, onBack, className = "", children = null }: { wide: boolean; onBack(): void; className?: string; children?: ReactNode }) {
  const { settings } = useSettings();
  const t = useT();
  if (!settings.agentFriends) return children;
  if (!wide) return null;
  return <button type="button" className={`icon-button fork-inbox-back ${className}`} aria-label={t("Back|fork inbox")} title={t("Back|fork inbox")} onClick={onBack}><ArrowLeft aria-hidden="true" /></button>;
}

/** The inbox More's way out (App.tsx spreads this over its item): the same back arrow, not the app's mark. */
export const forkInboxExitItem = ({ agentFriends }: { agentFriends: boolean }) => agentFriends ? { icon: ArrowLeft, glyph: undefined } : {};
