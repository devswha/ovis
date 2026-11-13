/**
 * The agent inbox as a mode of the app: the list of agents and the thread a row opens, in the shell's place, on a
 * phone and on a desktop (components/InboxList.tsx, components/InboxMode.tsx). The address says the mode
 * (`?app=inbox`), in a parameter of its own that lib/deepLink.ts leaves in place while the app moves between panes,
 * so a reload, a link, Back and Forward agree on where the app is. A change of mode is one history entry in either
 * direction, and Back undoes it; a page that opened in the mode has nothing of the app under it. A phone whose
 * device setting says so (Settings → Agent inbox on a phone) starts in the mode: its address takes the mark by a
 * replace, so Back on its list still leaves the app.
 */
import { useCallback, useEffect, useState } from "react";
import { inboxStartsOpen } from "./agentInbox.ts";
import { NAV_KEY, type AppLink } from "./deepLink.ts";
import { pageAddress, pageSearch } from "./pageQuery.ts";

declare const __HERDR_TEST_HOOKS__: boolean | undefined;

/**
 * Whether the mode is offered: its entries are drawn (More's Open agent inbox, the sidebar's foot) and every build
 * reads its address. While false only a build with test hooks reads the address (the browser lane's demo build, as
 * lib/crashProbe.ts has it), so the browser scripts can open the mode and a shipped build or the published demo
 * ignores it.
 */
export const INBOX_MODE_OFFERED: boolean = true;

const PARAM = "app";
const INBOX = "inbox";

/** Whether a build reads the mode's address at all. */
export function inboxModeRead(offered: boolean = INBOX_MODE_OFFERED, hooks: boolean = typeof __HERDR_TEST_HOOKS__ === "boolean" && __HERDR_TEST_HOOKS__): boolean {
  return offered || hooks;
}

/** Whether an address is the inbox mode's. */
export function inboxAddress(search: string): boolean {
  return new URLSearchParams(search).get(PARAM) === INBOX;
}

/** `search` with the mode's mark set or dropped, everything else as it was. */
export function withInboxAddress(search: string, inbox: boolean): string {
  const query = new URLSearchParams(search);
  if (inbox) query.set(PARAM, INBOX);
  else if (query.get(PARAM) === INBOX) query.delete(PARAM);
  const text = query.toString();
  return text ? `?${text}` : "";
}

/**
 * Whether a page starts in the mode on this device (Settings → Agent inbox on a phone): a phone-width window whose
 * address is the app's own start, which opens the list, or names a pane (a tapped alert, a link), which opens that
 * pane's thread with the list behind its Back. An address that names only a workspace or a file opens as it always
 * did, and so does every wider window.
 */
export function startsInInbox(setting: boolean, phone: boolean, link: AppLink | null): boolean {
  return setting && phone && (inboxStartsOpen(true, link) || Boolean(link?.pane));
}

export interface InboxMode {
  /** the app is in the inbox mode */
  on: boolean;
  /**
   * Whether the address the history is on is the mode's. A Back or Forward lands on its entry before React draws
   * the mode that entry is in, so what a listener does with the entry is decided here, not by `on`.
   */
  at(): boolean;
  /** into the mode, by one history entry */
  enter(): void;
  /** out of it, by one history entry */
  leave(): void;
}

/**
 * The mode the address names, kept in step with Back and Forward. Its popstate listener only reads: every
 * listener after it hears the same event (src/conventions.test.ts).
 */
export function useInboxMode({ read = inboxModeRead(), startsIn = false }: {
  read?: boolean;
  /** this device starts in the mode whatever its address says: read once, as the page loads */
  startsIn?: boolean;
} = {}): InboxMode {
  const [on, setOn] = useState(() => read && (startsIn || inboxAddress(pageSearch())));
  useEffect(() => {
    if (!read || !startsIn || inboxAddress(pageSearch())) return;
    window.history.replaceState(window.history.state, "", pageAddress(window.location.pathname, withInboxAddress(pageSearch(), true), window.location.hash));
    // at load only: where the device starts, not where it stays
  }, []);
  useEffect(() => {
    if (!read) return;
    const onPop = (): void => setOn(inboxAddress(pageSearch()));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [read]);
  const go = useCallback((next: boolean): void => {
    if (!read) return;
    const search = withInboxAddress(pageSearch(), next);
    if (search !== pageSearch()) window.history.pushState({ [NAV_KEY]: true }, "", pageAddress(window.location.pathname, search, window.location.hash));
    setOn(next);
  }, [read]);
  const enter = useCallback((): void => go(true), [go]);
  const leave = useCallback((): void => go(false), [go]);
  const at = useCallback((): boolean => read && inboxAddress(pageSearch()), [read]);
  return { on, at, enter, leave };
}
