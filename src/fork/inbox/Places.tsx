import type { ReactNode } from "react";
import { GitPullRequest, Notebook } from "lucide-react";

import { useT } from "../../lib/i18n.ts";
import { useSettings } from "../../lib/settings.ts";
import { ForkGithubPane, GithubInbox, type ViewProps } from "../github/GithubInbox.tsx";
import { NotesInbox, NotesPane } from "../notes/NotesInbox.tsx";
import { openPlace, usePlace } from "./place.ts";

/** One line in App: the agent inbox's list slot, showing the place picked (place.ts) in place of the agents. */
export function ForkPlaceSection({ children, ...props }: ViewProps & { children: ReactNode }) {
  const { settings } = useSettings();
  const current = usePlace();
  if (!settings.pullRequests && !settings.notes) return children;
  return <div className="fork-github-slot">
    {current === "github" && settings.pullRequests ? <GithubInbox {...props} />
      : current === "notes" && settings.notes ? <NotesInbox wide={props.wide} watching={props.watching} />
      : children}
  </div>;
}

/** One line in App's pane area: over the wide chat area, the place's page or a word on how to open one. */
export function ForkPlacePane(props: ViewProps & { inMode?: boolean; enter?(): void }) {
  const { settings } = useSettings();
  const current = usePlace();
  return <>
    <ForkGithubPane {...props} />
    {settings.notes && props.wide && current === "notes" && <NotesPane watching={props.watching} />}
  </>;
}

/** The phone's ways in: round buttons in the agent inbox's top row, beside New workspace. */
export function ForkPlaceOpen() {
  const { settings } = useSettings();
  const t = useT();
  return <>
    {settings.notes && <button type="button" className="icon-button inbox-round fork-github-open" aria-label={t("Notes")} title={t("Notes")}
      onClick={() => openPlace("notes", true)}><Notebook aria-hidden="true" /></button>}
    {settings.pullRequests && <button type="button" className="icon-button inbox-round fork-github-open" aria-label={t("Pull requests")} title={t("Pull requests")}
      onClick={() => openPlace("github", true)}><GitPullRequest aria-hidden="true" /></button>}
  </>;
}
