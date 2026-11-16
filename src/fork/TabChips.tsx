import { useEffect, useRef } from "react";
import { Terminal } from "lucide-react";
import type { HerdrPane, HerdrTab, PaneInfo } from "../../shared/protocol.ts";
import { rowMenuAnchor } from "../components/RowMenu.tsx";
import type { useTabReorder } from "../lib/useTabReorder.ts";
import { ROLE_ICONS } from "./AgentRole.tsx";
import type { groupAgentTabs } from "./groupAgentTabs.ts";
import "./tab-chips.css";

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
  onMove?: (tabId: string, direction: -1 | 1) => void;
  drag?: Pick<ReturnType<typeof useTabReorder>, "onPointerDown" | "onPointerMove" | "onPointerUp" | "cancelDrag" | "consumeClick">;
  /** working / blocked / waiting / done colour the icon itself; no separate dot */
  status: (tab: HerdrTab) => string | null;
  sheet?: boolean;
  onDismiss?: () => void;
  panelId?: string;
  popup?: "menu" | "dialog";
}

/** Folded drags use sibling geometry; root tabs retain upstream's geometry. */
export function forkChipBoundary(group: ReturnType<typeof groupAgentTabs>, row: HTMLElement | null, id: string, x: number): number | null | undefined {
  if (!group.parentOf.has(id)) return undefined;
  for (const chip of row?.querySelectorAll<HTMLElement>(".fork-tab-chip") ?? []) {
    const box = chip.getBoundingClientRect();
    if (x >= box.left && x <= box.right) return group.dropBoundary(id, chip.dataset["tabId"] ?? "", x >= box.left + box.width / 2);
  }
  return null;
}

/** Scroll the selected child itself into view, falling back to the upstream active tab. */
export function forkOpenTab(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>('.fork-tab-chip[aria-selected="true"]') ?? row.querySelector<HTMLElement>(".tab-strip-item.is-active");
}

/** Sibling controls, never buttons inside the parent's tab/menu button. */
export function ForkTabChips({ tabs, paneFor, nameOf, selectedTab, onSelect, onMenu, onClose, onRename, onMove, drag, status, sheet = false, onDismiss, panelId, popup = "menu" }: Props) {
  const held = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null>(null);
  const cancel = (): void => { if (held.current) clearTimeout(held.current.timer); held.current = null; };
  useEffect(() => cancel, []);
  if (!tabs.length) return null;
  const menu = (tab: HerdrTab, anchor: HTMLElement, point?: Point): void => {
    cancel();
    const target = rowMenuAnchor(anchor) ?? anchor;
    onDismiss?.(); onMenu(tab, target, point);
  };
  return <span className="fork-tab-chips">
    {tabs.map((tab) => {
      const pane = paneFor(tab) as HerdrPane | undefined;
      const Icon = pane?.agent_role ? ROLE_ICONS[pane.agent_role] : Terminal;
      const active = tab.tab_id === selectedTab;
      return <button key={tab.tab_id} type="button" role={sheet ? popup === "menu" ? "menuitemcheckbox" : undefined : "tab"} className={`fork-tab-chip${sheet ? " row-sheet-aside" : ""}`} data-tab-id={tab.tab_id} data-status={status(tab) ?? undefined}
        title={nameOf(tab)} aria-label={nameOf(tab)} aria-selected={sheet ? undefined : active} aria-pressed={sheet && popup === "dialog" ? active : undefined} aria-checked={sheet && popup === "menu" ? active : undefined}
        aria-controls={sheet ? undefined : panelId} tabIndex={sheet || active ? 0 : -1} aria-haspopup={popup}
        aria-keyshortcuts={onMove ? "Shift+F10 Alt+Shift+ArrowLeft Alt+Shift+ArrowRight" : "Shift+F10"}
        onDragStart={(event) => event.preventDefault()}
        onLostPointerCapture={() => drag?.cancelDrag()}
        onMouseDown={sheet ? (event) => event.preventDefault() : undefined}
        onPointerDown={(event) => {
          cancel();
          if (event.pointerType === "mouse") { drag?.onPointerDown(event, tab.tab_id); return; }
          const anchor = event.currentTarget;
          const press = { x: event.clientX, y: event.clientY, fired: false, timer: setTimeout(() => {
            press.fired = true;
            const target = rowMenuAnchor(anchor) ?? anchor;
            onDismiss?.(); onMenu(tab, target);
          }, 450) };
          held.current = press;
        }}
        onPointerMove={(event) => { const press = held.current; if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) cancel(); drag?.onPointerMove(event); }}
        onPointerUp={(event) => { if (held.current) clearTimeout(held.current.timer); drag?.onPointerUp(event); }}
        onPointerCancel={() => { cancel(); drag?.cancelDrag(); }}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (!held.current?.fired) menu(tab, event.currentTarget, { x: event.clientX, y: event.clientY }); }}
        onClick={(event) => {
          if (held.current?.fired) { cancel(); return; }
          cancel();
          if (drag?.consumeClick(event.detail) || event.ctrlKey) return;
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
          } else if (event.altKey && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            event.preventDefault(); event.stopPropagation();
            if (!event.repeat) onMove?.(tab.tab_id, event.key === "ArrowLeft" ? -1 : 1);
          }
        }}>
        <Icon aria-hidden="true" />
      </button>;
    })}
  </span>;
}
