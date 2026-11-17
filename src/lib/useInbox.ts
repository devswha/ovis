import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { INBOX_FILTERS, inboxStartsOpen, type InboxFilter } from "./agentInbox.ts";
import type { PaneView } from "./actions.ts";
import type { AppLink } from "./deepLink.ts";
import { focusWorkspaceListToggle } from "./focus.ts";
import { newQuestionReads } from "./useInboxQuestions.ts";
import { newSummaryReads } from "./useInboxSummaries.ts";

export function useInboxShell({ inMode, shown, show, open, enter, setDrawerOpen, hideFile, selectedPaneId, linkLanded, thread, here, wide = false, focusInput }: {
  inMode: boolean;
  shown: boolean;
  show(): void;
  open?: () => void;
  enter(): void;
  setDrawerOpen(open: boolean): void;
  hideFile(): void;
  selectedPaneId: string | null;
  linkLanded: boolean;
  thread: string | null;
  here?: () => string | null;
  wide?: boolean;
  focusInput?: () => void;
}): { enterInbox(): void; returnTo: string | null } {
  useEffect(() => { if (inMode) setDrawerOpen(false); }, [inMode, setDrawerOpen]);
  useEffect(() => { if (inMode && !shown && selectedPaneId === null && linkLanded) show(); }, [inMode, shown, selectedPaneId, linkLanded, show]);
  const wasInMode = useRef(inMode);
  useEffect(() => {
    if (wasInMode.current === inMode) return;
    wasInMode.current = inMode;
    if (!inMode) focusWorkspaceListToggle("lost");
  }, [inMode]);
  const listed = useRef(false);
  const focusInputRef = useRef(focusInput); focusInputRef.current = focusInput;
  useEffect(() => {
    if (!inMode) { listed.current = false; return; }
    if (shown) { listed.current = true; return; }
    if (thread === null || !listed.current) return;
    listed.current = false;
    window.requestAnimationFrame(() => {
      if (document.activeElement !== null && document.activeElement !== document.body) return;
      if (window.matchMedia?.("(pointer: coarse)").matches !== true) focusInputRef.current?.();
      focusWorkspaceListToggle("lost");
    });
  }, [inMode, shown, thread]);
  const leftOn = useRef<string | null>(null);
  useEffect(() => { if (inMode) leftOn.current = thread; }, [inMode, thread]);
  const entry = useRef({ here, wide, open }); entry.current = { here, wide, open };
  const opening = useRef<string | null>(null);
  const enterInbox = useCallback((): void => {
    setDrawerOpen(false); hideFile(); enter(); show();
    const pane = entry.current.here?.() ?? null;
    opening.current = pane !== null && entry.current.open !== undefined && (entry.current.wide || leftOn.current === pane) ? pane : null;
  }, [setDrawerOpen, hideFile, enter, show]);
  useEffect(() => {
    if (!inMode || !shown || opening.current === null) return;
    opening.current = null;
    entry.current.open?.();
  }, [inMode, shown]);
  const [was, setWas] = useState({ thread, inMode });
  const [returnTo, setReturnTo] = useState<string | null>(null);
  if (was.thread !== thread || was.inMode !== inMode) {
    setWas({ thread, inMode });
    setReturnTo(inMode && was.inMode && thread === null && shown ? was.thread : null);
  }
  return { enterInbox, returnTo };
}

export function wayInOpensThread({ hasRow, view, peek, drawnPanes, splitShown }: {
  hasRow: boolean; view: PaneView; peek: boolean; drawnPanes: number; splitShown: boolean;
}): boolean {
  return hasRow && !splitShown && drawnPanes === 1 && view === "chat" && !peek;
}

export interface InboxListHandle {
  toTop(): void;
}

export const INBOX_FROM_KEY = "ovis:from-inbox";

export const INBOX_LIST_KEY = "ovis:inbox-list";
interface KeptList { filter: InboxFilter; query: string; scroll: number }

function keptList(): KeptList {
  const fresh: KeptList = { filter: "all", query: "", scroll: 0 };
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(INBOX_LIST_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return fresh;
    const { filter, query, scroll } = value as Partial<Record<keyof KeptList, unknown>>;
    return {
      filter: INBOX_FILTERS.find((choice) => choice === filter) ?? "all",
      query: typeof query === "string" ? query : "",
      scroll: typeof scroll === "number" && Number.isFinite(scroll) && scroll >= 0 ? scroll : 0,
    };
  } catch {
    return fresh;
  }
}

function keepList(list: KeptList): void {
  try {
    window.sessionStorage.setItem(INBOX_LIST_KEY, JSON.stringify(list));
  } catch {
  }
}

export function useInbox({ on, initialLink, drawerOpenRef }: {
  on: boolean; initialLink: AppLink | null; drawerOpenRef: RefObject<boolean>;
}) {
  const enabled = on;
  const [open, setOpen] = useState(() => inboxStartsOpen(on, initialLink));
  const shown = open && enabled;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const [opening, setOpening] = useState(shown ? 1 : 0);
  const [wasShown, setWasShown] = useState(shown);
  if (wasShown !== shown) {
    setWasShown(shown);
    if (shown) setOpening(opening + 1);
  }
  const focusTaken = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const coldRef = useRef(shown);
  useEffect(() => { if (!shown) coldRef.current = false; }, [shown]);
  const cold = shown && coldRef.current;
  const show = useCallback(() => setOpen(true), []);
  const leave = useCallback(() => setOpen(false), []);
  const goingBack = useRef(false);
  useEffect(() => {
    const landed = (): void => { goingBack.current = false; };
    window.addEventListener("popstate", landed);
    window.addEventListener("pageshow", landed);
    return () => {
      window.removeEventListener("popstate", landed);
      window.removeEventListener("pageshow", landed);
    };
  }, []);
  useEffect(() => { if (shown) goingBack.current = false; }, [shown]);
  const back = useCallback(() => {
    if (goingBack.current) return;
    if ((window.history.state as Record<string, unknown> | null)?.[INBOX_FROM_KEY] === true) {
      goingBack.current = true;
      window.history.back();
    } else setOpen(true);
  }, []);
  const [kept] = useState(keptList);
  const [filter, setFilter] = useState<InboxFilter>(kept.filter);
  const [query, setQuery] = useState(kept.query);
  const scroll = useRef(kept.scroll);
  const list = useRef<InboxListHandle>(null);
  const listRef = useRef({ filter, query });
  listRef.current = { filter, query };
  useEffect(() => { keepList({ filter, query, scroll: scroll.current }); }, [filter, query]);
  useEffect(() => {
    const store = (): void => { keepList({ ...listRef.current, scroll: scroll.current }); };
    const hidden = (): void => { if (document.visibilityState === "hidden") store(); };
    window.addEventListener("pagehide", store);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", store);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  const [questionReads] = useState(newQuestionReads);
  const [summaryReads] = useState(newSummaryReads);
  const coveredRef = useMemo(() => ({ get current(): boolean { return drawerOpenRef.current === true || shownRef.current; } }) as RefObject<boolean>, [drawerOpenRef]);
  return { enabled, shown, cold, shownRef, enabledRef, coveredRef, show, leave, back, filter, setFilter, query, setQuery, scroll, list, questionReads, summaryReads, focus: { opening, taken: focusTaken } };
}
