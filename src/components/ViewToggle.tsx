import { MessageSquare, SquareTerminal } from "lucide-react";

import { useT } from "../lib/i18n.ts";

type PaneView = "chat" | "terminal";

/**
 * The open pane's lens at the end of the header's tabs: one button that shows the lens on screen and
 * flips to the other, as ⌘⇧J does. Each pane keeps its own lens (lib/usePaneLens.ts).
 */
export function ViewToggle({ view, terminalAttach, onToggle }: { view: PaneView; terminalAttach: boolean; onToggle: () => void }) {
  const t = useT();
  const title = view === "terminal" ? t("Switch to chat (⌘⇧J)")
    : terminalAttach ? t("Switch to terminal (⌘⇧J)") : t("Live terminal: coming to Windows PCs once herdr can attach there");
  const Icon = view === "chat" ? MessageSquare : SquareTerminal;
  return <button type="button" className="view-toggle" data-view={view} data-terminal-soon={!terminalAttach || undefined}
    aria-label={t("Terminal")} aria-pressed={view === "terminal"} title={title} onClick={onToggle}>
    <Icon aria-hidden="true" />
  </button>;
}
