import { cloneElement, createContext, useContext, type MouseEventHandler, type ReactElement } from "react";
import { FolderTree, GitPullRequest, Notebook, type LucideIcon } from "lucide-react";

import type { InboxRailProps } from "../../components/InboxRail.tsx";
import { useT } from "../../lib/i18n.ts";
import { useMediaQuery } from "../../lib/useMediaQuery.ts";
import { useSettings } from "../../lib/settings.ts";
import type { Navigation } from "../settings/settings.ts";
import "./Rail.css";
import { setPlace, usePlace } from "./place.ts";

/**
 * Settings → Fork → Navigation as this window draws it. A phone has no rail, so there Rail is drawn as Footer:
 * the places stay in the drawer's foot.
 */
export function useNavigation(): Navigation {
  const { settings } = useSettings();
  const wide = useMediaQuery("(min-width: 769px)");
  return settings.navigation === "rail" && !wide ? "footer" : settings.navigation;
}

/** How the rail beside the workspaces sidebar enters the agent inbox; null in the inbox's own column. */
const EnterInbox = createContext<(() => void) | null>(null);
export const useRailEnter = (): (() => void) | null => useContext(EnterInbox);

/**
 * Navigation → Rail: upstream's inbox rail (App.tsx hands it in) also before the workspaces sidebar, with the
 * workspaces as its current place. Its other places enter the inbox on theirs.
 */
export function ForkWorkspaceRail({ enter, children }: { enter(): void; children: ReactElement<InboxRailProps> }) {
  if (useNavigation() !== "rail") return null;
  return <EnterInbox.Provider value={enter}>{cloneElement(children, { onExit: () => {}, onInbox: enter })}</EnterInbox.Provider>;
}

/** One place on the rail, drawn as the rail's own inbox button. */
export function RailPlace({ label, icon: Icon, current, onClick }: { label: string; icon: LucideIcon; current: boolean; onClick(): void }) {
  return <button type="button" className="icon-button inbox-rail-item inbox-rail-place" aria-label={label} title={label}
    aria-current={current ? "page" : undefined} onClick={onClick}><Icon aria-hidden="true" /></button>;
}

/** The rail's first place (Navigation → Rail), where upstream has its way out: the workspaces. */
export function RailWorkspaces({ onExit }: { onExit(): void }) {
  const enter = useRailEnter();
  const t = useT();
  return <RailPlace label={t("Workspace list")} icon={FolderTree} current={enter !== null} onClick={enter === null ? onExit : () => {}} />;
}

/** Where upstream's rail ends its first group with the inbox: Navigation → Rail puts the workspaces before it. */
export function ForkRailWorkspaces({ onExit }: { onExit(): void }) {
  return useNavigation() === "rail" ? <RailWorkspaces onExit={onExit} /> : null;
}

/**
 * The rail's inbox button (InboxRail.tsx wraps it), then the fork's places after it: Pull requests and Notes, each
 * while it is on. The inbox button's own press and focus still run. Beside the workspaces
 * sidebar no place of these is current, and each enters the inbox on its own.
 */
export function ForkRailPlaces({ children }: { children: ReactElement<{ "aria-current"?: "page"; onClick?: MouseEventHandler<HTMLButtonElement> }> }) {
  const { settings } = useSettings();
  const rail = useNavigation() === "rail";
  const enter = useRailEnter();
  const place = usePlace();
  const t = useT();
  if (!settings.pullRequests && !settings.notes && !rail) return children;
  const current = enter === null ? place : null;
  const open = (next: "github" | "notes") => () => { setPlace(next); enter?.(); };
  return <>
    {cloneElement(children, { "aria-current": current === "inbox" ? "page" : undefined, onClick: (event) => { setPlace("inbox"); children.props.onClick?.(event); } })}
    {settings.pullRequests && <RailPlace label={t("Pull requests")} icon={GitPullRequest} current={current === "github"} onClick={open("github")} />}
    {settings.notes && <RailPlace label={t("Notes")} icon={Notebook} current={current === "notes"} onClick={open("notes")} />}
  </>;
}
