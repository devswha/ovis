import { useEffect, useRef, type ReactNode, type CSSProperties } from "react";
import { Check, Hammer, Terminal } from "lucide-react";
import type { HerdrPane, HerdrTab, PaneInfo } from "../../shared/protocol.ts";
import "./tab-chips.css";

export const CHIP_WIDTH = 24;
export function forkTabGroupStyle(count: number): CSSProperties | undefined {
  return count ? { "--fork-chip-room": `${count * (CHIP_WIDTH + 2) + 4}px` } as CSSProperties : undefined;
}

type Point = { x: number; y: number };
interface Props {
  tabs: HerdrTab[];
  paneFor: (tab: HerdrTab) => PaneInfo | undefined;
  nameOf: (tab: HerdrTab) => string;
  selectedTab: string;
  onSelect: (paneId: string) => void;
  onMenu: (tab: HerdrTab, anchor: HTMLElement, point?: Point) => void;
  onClose?: (tab: HerdrTab) => void;
  onRename?: (tab: HerdrTab) => void;
  statusMark: (tab: HerdrTab) => ReactNode;
  sheet?: boolean;
  onDismiss?: () => void;
  panelId?: string;
  popup?: "menu" | "dialog";
}

/** Sibling controls, never buttons inside the parent's tab/menu button. */
export function ForkTabChips({ tabs, paneFor, nameOf, selectedTab, onSelect, onMenu, onClose, onRename, statusMark, sheet = false, onDismiss, panelId, popup = "menu" }: Props) {
  const held = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(null);
  const cancel = (): void => { if (held.current) clearTimeout(held.current.timer); held.current = null; };
  useEffect(() => cancel, []);
  if (!tabs.length) return null;
  const menu = (tab: HerdrTab, anchor: HTMLElement, point?: Point): void => { cancel(); onDismiss?.(); onMenu(tab, anchor, point); };
  return <span className="fork-tab-chips">
    {tabs.map((tab) => {
      const pane = paneFor(tab) as HerdrPane | undefined;
      const Icon = pane?.agent_role === "implement" ? Hammer : pane?.agent_role === "review" ? Check : Terminal;
      const active = tab.tab_id === selectedTab;
      return <button key={tab.tab_id} type="button" role={sheet ? undefined : "tab"} className={`fork-tab-chip${sheet ? " row-sheet-aside" : ""}`} data-tab-id={tab.tab_id}
        title={nameOf(tab)} aria-label={nameOf(tab)} aria-selected={sheet ? undefined : active} aria-pressed={sheet ? active : undefined}
        aria-controls={sheet ? undefined : panelId} tabIndex={sheet || active ? 0 : -1} aria-haspopup={popup}
        onPointerDown={(event) => {
          cancel();
          if (event.pointerType === "mouse") return;
          const anchor = event.currentTarget;
          const press = { x: event.clientX, y: event.clientY, fired: false, timer: setTimeout(() => {
            press.fired = true;
            onDismiss?.(); onMenu(tab, anchor);
          }, 450) };
          held.current = press;
        }}
        onPointerMove={(event) => { const press = held.current; if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) cancel(); }}
        onPointerUp={() => { if (held.current) clearTimeout(held.current.timer); }} onPointerCancel={cancel}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (!held.current?.fired) menu(tab, event.currentTarget, { x: event.clientX, y: event.clientY }); }}
        onClick={(event) => {
          if (held.current?.fired) { cancel(); return; }
          cancel();
          if (event.ctrlKey) return;
          event.currentTarget.focus({ preventScroll: true });
          if (pane) onSelect(pane.pane_id);
          onDismiss?.();
        }}
        onAuxClick={(event) => { if (event.button === 1 && onClose) { event.preventDefault(); onClose(tab); } }}
        onDoubleClick={onRename ? () => onRename(tab) : undefined}
        onKeyDown={(event) => {
          if (event.key === "F2" || event.key === "Delete" || event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault(); event.stopPropagation();
            if (event.repeat) return;
            if (event.key === "F2") onRename?.(tab);
            else if (event.key === "Delete") onClose?.(tab);
            else menu(tab, event.currentTarget);
          } else if (event.altKey && event.shiftKey) { event.preventDefault(); event.stopPropagation(); }
        }}>
        <Icon aria-hidden="true" />{statusMark(tab)}
      </button>;
    })}
  </span>;
}
