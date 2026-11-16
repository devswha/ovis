import type { ReactElement } from "react";
import { CircleHelp, FolderTree, GitPullRequest, Inbox } from "lucide-react";

import type { InboxRailProps } from "../../components/InboxRail.tsx";
import { SidebarFooter } from "../../components/SidebarFooter.tsx";
import { useT } from "../../lib/i18n.ts";
import { useSettings } from "../../lib/settings.ts";
import { setGithubSection, useGithubSection } from "../github/GithubInbox.tsx";

type Place = "workspaces" | "inbox" | "github";

/**
 * The app's places as icons at the end of a sidebar foot's gear row (GithubInbox.css lays the row out): the
 * workspaces, the agent inbox and Pull requests, the one shown marked. The same row ends both the workspaces
 * sidebar and the agent inbox's column, so the two read as one sidebar.
 */
function FootPlaces({ current, onPlace, waiting = null }: { current: Place; onPlace(place: Place): void; waiting?: InboxRailProps["waiting"] }) {
  const { settings } = useSettings();
  const t = useT();
  const place = (id: Place, label: string, Icon: typeof Inbox) => <button type="button" className="btn btn-ghost sidebar-footer-action fork-github-foot-open"
    aria-label={label} title={label} aria-current={current === id ? "page" : undefined} onClick={() => onPlace(id)}><Icon aria-hidden="true" /></button>;
  return <div className="fork-github-foot">
    {waiting !== null && <button type="button" className="btn btn-ghost sidebar-footer-action fork-github-foot-open fork-foot-waiting"
      aria-label={t("{count} waiting for you", { count: waiting.count })} title={t("Open the next session waiting for you")} onClick={waiting.open}>
      <CircleHelp aria-hidden="true" /><span className="header-more-dot is-waiting" data-count={waiting.count} aria-hidden="true" />
    </button>}
    {settings.inboxFooter && place("workspaces", t("Workspace list"), FolderTree)}
    {place("inbox", t("Agent inbox"), Inbox)}
    {settings.pullRequests && place("github", t("Pull requests"), GitPullRequest)}
  </div>;
}

/**
 * The workspaces sidebar's foot (App.tsx wraps upstream's inbox row): with Pull requests or the inbox footer on,
 * the places as icons on the gear's row instead of the row. Off, upstream's inbox row stays.
 */
export function ForkSidebarFoot({ children }: { children: ReactElement<{ onOpen(): void }> }) {
  const { settings } = useSettings();
  if (!settings.pullRequests && !settings.inboxFooter) return children;
  const enter = children.props.onOpen;
  return <FootPlaces current="workspaces" onPlace={(place) => {
    if (place === "workspaces") return;
    setGithubSection(place);
    enter();
  }} />;
}

/**
 * The agent inbox's wide column (App.tsx wraps upstream's rail): with the inbox footer on, the workspaces
 * sidebar's own foot (SidebarFooter) under the list instead of the rail, with the places and the agents that wait
 * in its start slot. Alerts and the PCs menu are left out. Off, upstream's rail stays.
 */
export function ForkInboxFoot({ children, watching, onUsageLogin }: { children: ReactElement<InboxRailProps>; watching: boolean; onUsageLogin(paneId: string): void }) {
  const { settings } = useSettings();
  const current = useGithubSection();
  if (!settings.inboxFooter) return children;
  const { onExit, onInbox, onSettings, waiting } = children.props;
  return <SidebarFooter watching={watching} onUsageLogin={onUsageLogin} onSettings={onSettings}
    start={<FootPlaces current={current} waiting={waiting} onPlace={(place) => {
      if (place === "workspaces") { onExit(); return; }
      setGithubSection(place);
      if (place === "inbox") onInbox();
    }} />} />;
}

/**
 * With the inbox footer on, the agent inbox's open thread ends in the workspaces view's status bar too (App.tsx
 * adds this to where the bar shows), so a pane reads the same in both: not while Pull requests stands over it.
 */
export function useForkInboxStatusBar(threadShown: boolean): boolean {
  const { settings } = useSettings();
  const current = useGithubSection();
  return settings.inboxFooter && threadShown && current !== "github";
}
