import { MessageCircle, SquareTerminal } from "lucide-react";
import { LensToggle } from "../components/LensToggle.tsx";
import type { PaneView } from "../lib/actions.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";

/** Preserve upstream's header controls unless this device explicitly moves them to More. */
export function HeaderLens({ view, peek, terminalAttach, sheet, thread, title, onToggle, onView }: {
  view: PaneView; peek: boolean; terminalAttach: boolean; sheet: boolean; thread: boolean;
  title: (label: string) => string; onToggle: () => void; onView: (view: PaneView) => void;
}) {
  const { settings } = useSettings();
  const t = useT();
  if (settings.moreViewToggle && !thread) return null;
  if (sheet || thread) return <LensToggle view={view} peek={peek} terminalAttach={terminalAttach} thread={thread} title={title} onToggle={onToggle} />;
  return <div className="view-switch" data-view={view} role="group" aria-label={`${t("Chat")} / ${t("Terminal")}`}>
    <button type="button" className="lens-option is-chat" aria-pressed={view === "chat"} aria-label={t("Chat")} title={title(t("Chat transcript"))} onClick={() => onView("chat")}>
      <MessageCircle aria-hidden="true" /><span className="lens-label">{t("Chat")}</span>
    </button>
    <button type="button" className="lens-option is-terminal" aria-pressed={view === "terminal"} aria-label={terminalAttach ? t("Terminal") : `${t("Terminal")} · ${t("soon")}`}
      title={terminalAttach ? title(t("Live terminal")) : t("Live terminal: coming to Windows PCs once herdr can attach there")} onClick={() => onView("terminal")}>
      <SquareTerminal aria-hidden="true" /><span className="lens-label">{t("Terminal")}</span>
      {!terminalAttach && <span className="pill pill-soon">{t("soon")}</span>}
    </button>
    <span className="lens-thumb" aria-hidden="true" />
  </div>;
}
