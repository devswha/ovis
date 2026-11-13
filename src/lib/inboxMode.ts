/**
 * The agent inbox as a mode of the app: the list of agents and the thread a row opens, in the shell's place, on a
 * phone and on a desktop (components/InboxList.tsx, components/InboxMode.tsx). The address says the mode
 * (`?app=inbox`), in a parameter of its own that lib/deepLink.ts leaves in place while the app moves between panes,
 * so a reload, a link, Back and Forward agree on where the app is. A change of mode is one history entry in either
 * direction, and Back undoes it; a page that opened in the mode has nothing of the app under it.
 */
import { useCallback, useEffect, useState } from "react";
import { NAV_KEY } from "./deepLink.ts";
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
export function useInboxMode({ read = inboxModeRead() }: { read?: boolean } = {}): InboxMode {
  const [on, setOn] = useState(() => read && inboxAddress(pageSearch()));
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
