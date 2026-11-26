import type { ReactElement } from "react";
import { CircleHelp, FolderTree, GitPullRequest, Inbox, Notebook } from "lucide-react";

import type { InboxRailProps } from "../../components/InboxRail.tsx";
import { SidebarFooter } from "../../components/SidebarFooter.tsx";
import { useT } from "../../lib/i18n.ts";
import { useSettings } from "../../lib/settings.ts";
import { setPlace, usePlace, type Place as InboxPlace } from "./place.ts";
import { useNavigation } from "./Rail.tsx";

type Place = "workspaces" | InboxPlace;

/**
 * The app's places as icons at the end of a sidebar foot's gear row (GithubInbox.css lays the row out): under
 * Navigation → Footer the workspaces, the agent inbox, Pull requests and Notes, the one shown marked, and the same row
 * ends both the workspaces sidebar and the agent inbox's column, so the two read as one sidebar. Under Default only
 * the inbox, where upstream's inbox row was: the inbox's rail has the rest.
 */
function FootPlaces({ current, onPlace, waiting = null }: { current: Place; onPlace(place: Place): void; waiting?: InboxRailProps["waiting"] }) {
  const { settings } = useSettings();
  const footer = useNavigation() === "footer";
  const t = useT();
  const place = (id: Place, label: string, Icon: typeof Inbox) => <button type="button" className="btn btn-ghost sidebar-footer-action fork-github-foot-open"
    aria-label={label} title={label} aria-current={current === id ? "page" : undefined} onClick={() => onPlace(id)}><Icon aria-hidden="true" /></button>;
  return <div className="fork-github-foot">
    {waiting !== null && <button type="button" className="btn btn-ghost sidebar-footer-action fork-github-foot-open fork-foot-waiting"
      aria-label={t("{count} waiting for you", { count: waiting.count })} title={t("Open the next session waiting for you")} onClick={waiting.open}>
      <CircleHelp aria-hidden="true" /><span className="header-more-dot is-waiting" data-count={waiting.count} aria-hidden="true" />
    </button>}
    {footer && place("workspaces", t("Workspace list"), FolderTree)}
    {place("inbox", t("Agent inbox"), Inbox)}
    {footer && settings.pullRequests && place("github", t("Pull requests"), GitPullRequest)}
    {footer && settings.notes && place("notes", t("Notes"), Notebook)}
  </div>;
}

/**
 * Under Navigation → Footer or Rail the places are the fork's, not upstream's Inbox beside the gear (App.tsx passes
 * MachineSidebar no `inbox` then).
 */
export const useForkOwnsInboxEntry = (): boolean => useNavigation() !== "upstream";

/**
 * The workspaces sidebar's foot (App.tsx): under Navigation → Footer the places as icons on the gear's row, the
 * workspaces one marked. Default keeps upstream's Inbox entry; under Rail the rail has the places.
 */
export function ForkSidebarFoot({ onOpen }: { onOpen(): void }) {
  if (useNavigation() !== "footer") return null;
  return <FootPlaces current="workspaces" onPlace={(place) => {
    if (place === "workspaces") return;
    setPlace(place);
    onOpen();
  }} />;
}

/**
 * The agent inbox's wide column (App.tsx wraps upstream's rail): under Navigation → Footer, the workspaces
 * sidebar's own foot (SidebarFooter) under the list instead of the rail, with the places and the agents that wait
 * in its start slot. Alerts and the PCs menu are left out. Off, upstream's rail stays.
 */
export function ForkInboxFoot({ children, watching, onUsageLogin }: { children: ReactElement<InboxRailProps>; watching: boolean; onUsageLogin(paneId: string): void }) {
  const current = usePlace();
  if (useNavigation() !== "footer") return children;
  const { onExit, onInbox, onSettings, waiting } = children.props;
  return <SidebarFooter watching={watching} onUsageLogin={onUsageLogin} onSettings={onSettings}
    start={<FootPlaces current={current} waiting={waiting} onPlace={(place) => {
      if (place === "workspaces") { onExit(); return; }
      setPlace(place);
      if (place === "inbox") onInbox();
    }} />} />;
}

/**
 * Under Navigation → Footer, the agent inbox's open thread ends in the workspaces view's status bar too (App.tsx
 * adds this to where the bar shows), so a pane reads the same in both: not while Pull requests or Notes stands over it.
 */
export function useForkInboxStatusBar(threadShown: boolean): boolean {
  const footer = useNavigation() === "footer";
  const current = usePlace();
  return footer && threadShown && current === "inbox";
}
