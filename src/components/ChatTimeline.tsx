import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";

import { ChatRowMemoryContext, type ChatRowMemory } from "../lib/chatRowState.tsx";
import { dropPendingListScroll, listEndPadded } from "../lib/followScroll.ts";
import { chatSelectionClipboardPayload } from "../lib/markdownClipboard.ts";
// ChatTimeline.css is imported by ChatView: the frame and the loading state need it before this chunk

export interface ChatTimelineRow {
  readonly key: string;
  readonly beforeUser: boolean;
}

export interface ChatTimelineProps<Row extends ChatTimelineRow> {
  rows: readonly Row[];
  scope: string;
  source: string | undefined;
  scroller: RefObject<HTMLDivElement | null>;
  listRef: RefObject<LegendListRef | null>;
  following: RefObject<boolean>;
  /**
   * A click a following reader made is laid out where they are until the rows change; held by the
   * chat, which lets it go when the reader goes back to the end (Jump to latest), whatever set it.
   */
  manualLayout: RefObject<boolean>;
  /**
   * Set by the timeline while a selection is in progress in it: a mouse drag held down, or a
   * selection standing in its rows (a phone's long press leaves one). Nothing follows the end
   * under it, so the words a reader is selecting stay where they are (#1922, #2650); a reader still
   * following is put at the end once it is let go.
   */
  selecting: RefObject<boolean>;
  memories: Map<string, ChatRowMemory>;
  header: ReactNode;
  footer: ReactNode;
  label: string;
  onScroll: () => void;
  /** The timeline put the view at the end itself, at `top`: the next scroll event is read from there. */
  onFollowed: (top: number) => void;
  /** The reader opened something in a row (a tool, a folded block, a whole output): they read there. */
  onOpen: () => void;
  renderRow: (row: Row, index: number) => ReactNode;
}

/** One scroll owner; selected and focused rows stay real DOM nodes outside its window. */
export function ChatTimeline<Row extends ChatTimelineRow>({ rows, scope, source, scroller, listRef, following, manualLayout, selecting, memories, header, footer, label, onScroll, onFollowed, onOpen, renderRow }: ChatTimelineProps<Row>) {
  const [selectionKeys, setSelectionKeys] = useState<string[]>([]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useLayoutEffect(() => {
    setSelectionKeys([]);
    setFocusKey(null);
  }, [scope]);
  const rowKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  const positions = useMemo(() => new Map(rowKeys.map((key, index) => [key, index])), [rowKeys]);
  const pinned = useMemo(() => [...new Set(focusKey === null ? selectionKeys : [...selectionKeys, focusKey])], [selectionKeys, focusKey]);
  const extraData = useMemo(() => ({ renderRow }), [renderRow]);
  // where the view was when the chat last read it: where the list opened it, its scroll event, or the
  // follow's own move
  const heardTop = useRef<number | null>(null);
  const attachList = useCallback((instance: LegendListRef | null) => {
    listRef.current = instance;
    const node = instance?.getScrollableNode();
    scroller.current = node instanceof HTMLDivElement ? node : null;
    heardTop.current = scroller.current?.scrollTop ?? null;
  }, [listRef, scroller]);

  useLayoutEffect(() => {
    manualLayout.current = false;
    for (const key of memories.keys()) if (!positions.has(key)) memories.delete(key);
  }, [rows, memories, positions, manualLayout]);

  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const rowFor = (value: Node | null): string | null => {
      const element = value instanceof Element ? value : value?.parentElement;
      const row = element?.closest<HTMLElement>("[data-chat-row]");
      return row && node.contains(row) ? row.dataset.chatRow ?? null : null;
    };
    const selectionChanged = () => {
      const selection = getSelection();
      let first = rowKeys.length, last = -1;
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        for (const row of node.querySelectorAll<HTMLElement>("[data-chat-row]")) {
          const index = positions.get(row.dataset.chatRow ?? "");
          if (index !== undefined && range.intersectsNode(row)) {
            first = Math.min(first, index); last = Math.max(last, index);
          }
        }
      }
      const keys = last >= first ? rowKeys.slice(first, last + 1) : [];
      selectedKeys.current = keys;
      held.current();
      setSelectionKeys((previous) => previous.length === keys.length && previous.every((key, index) => key === keys[index]) ? previous : keys);
    };
    const focusChanged = () => setFocusKey(rowFor(document.activeElement));
    const focusOut = () => queueMicrotask(focusChanged);
    const interaction = (event: Event) => {
      const control = event.target instanceof Element ? event.target.closest("summary, .work-block-head, .work-row-head, .chat-tool-more") : null;
      // a pending work block's head opens nothing
      if (control === null || control.closest(".work-block.is-pending")) return;
      // captured before the row's own handler: what it shows now is what the click changes
      const details = control.matches("summary") ? control.parentElement : null;
      // Opening is reading there: following stops until the reader goes back to the end, so nothing
      // is held for them once they do (Jump to latest follows what grows next), not even a hold an
      // earlier click left. Another click a following reader makes is laid out where they are until
      // the rows change.
      if (control.matches(".chat-tool-more") || control.getAttribute("aria-expanded") === "false" || (details instanceof HTMLDetailsElement && !details.open)) {
        manualLayout.current = false;
        onOpen();
      } else if (following.current) {
        manualLayout.current = true;
        // a follow the list queued before this click would still land after it: the fold stays put
        dropPendingListScroll(listRef.current);
      }
    };
    // a mouse press can start a drag selection before any selection exists: held from the press
    const pressed = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      pressing.current = rowFor(event.target as Node | null) ?? "";
      held.current();
    };
    const released = () => {
      if (pressing.current === null) return;
      pressing.current = null;
      held.current();
    };
    // a button let go outside the window sends this page no up: the next move without it, or the
    // window losing focus, ends the press
    const moved = (event: PointerEvent) => { if (event.pointerType === "mouse" && (event.buttons & 1) === 0) released(); };
    document.addEventListener("selectionchange", selectionChanged);
    node.addEventListener("pointerdown", pressed, true);
    document.addEventListener("pointerup", released, true);
    document.addEventListener("pointercancel", released, true);
    document.addEventListener("pointermove", moved, { capture: true, passive: true });
    window.addEventListener("blur", released);
    node.addEventListener("focusin", focusChanged);
    node.addEventListener("focusout", focusOut);
    node.addEventListener("click", interaction, true);
    // on the document: a copy goes to where the selection starts, so one that begins outside the
    // chat (Select All) never reaches the chat itself. A field's own copy (the composer, a
    // copy button's hidden textarea) stays native.
    const copy = (event: ClipboardEvent) => {
      const selection = getSelection();
      if (event.defaultPrevented || !event.clipboardData || !selection) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable=true]")) return;
      const payload = chatSelectionClipboardPayload(selection, node);
      if (!payload) return;
      event.clipboardData.setData("text/plain", payload.text);
      if (payload.html !== null) event.clipboardData.setData("text/html", payload.html);
      event.preventDefault();
    };
    document.addEventListener("copy", copy);
    return () => {
      document.removeEventListener("selectionchange", selectionChanged);
      node.removeEventListener("pointerdown", pressed, true);
      document.removeEventListener("pointerup", released, true);
      document.removeEventListener("pointercancel", released, true);
      document.removeEventListener("pointermove", moved, { capture: true });
      window.removeEventListener("blur", released);
      node.removeEventListener("focusin", focusChanged);
      node.removeEventListener("focusout", focusOut);
      node.removeEventListener("click", interaction, true);
      document.removeEventListener("copy", copy);
    };
  }, [scroller, listRef, positions, rowKeys, onOpen, following, manualLayout]);

  // A measured row is followed in the frame it was measured in, before that frame paints. The list
  // measures inside a ResizeObserver callback and draws its new total in the microtask React queues
  // for it; this follow runs in a microtask queued after that one, once per batch of measurements,
  // and puts the view at the end: the scroller's, or the list's measured one while the list pads
  // the transcript to hold rows in place (listEndPadded). The list's own scroll to the end lands a frame later or more: on a slow device the
  // next change comes first, and the reader never catches up (#2624, #2647). A scroll the chat has
  // not heard yet (its event comes later in the frame) is read first, as that event would read it:
  // a reader who left the end is not pulled back.
  const followQueued = useRef(false);
  const scrolled = useRef(onScroll);
  scrolled.current = onScroll;
  const heard = useCallback(() => {
    heardTop.current = scroller.current?.scrollTop ?? null;
    scrolled.current();
  }, [scroller]);
  const followMeasured = useCallback(() => {
    if (followQueued.current) return;
    followQueued.current = true;
    queueMicrotask(() => {
      followQueued.current = false;
      const node = scroller.current, list = listRef.current;
      if (node === null || list === null || !following.current || manualLayout.current || selecting.current) return;
      if (node.scrollTop !== heardTop.current) {
        heard();
        if (!following.current || manualLayout.current || selecting.current) return;
      }
      const measured = list.getState().contentLength;
      const end = Math.max(0, (listEndPadded(node) ? measured : Math.max(measured, node.scrollHeight)) - node.clientHeight);
      if (Math.abs(node.scrollTop - end) <= 1) return;
      node.scrollTop = end;
      heardTop.current = node.scrollTop;
      onFollowed(node.scrollTop);
    });
  }, [scroller, listRef, following, manualLayout, selecting, heard, onFollowed]);

  // A selection in progress holds the row it started in where it is on screen (#1922, #2650): the
  // row a mouse pressed (a drag selection starts with the press), or the first row a selection
  // stands in (a phone's long press). Nothing follows the end, and what the layout moves, a row
  // above growing or the end shrinking, is scrolled back before it is painted; room is kept past
  // the end for that, so the browser cannot pull the view up with a shorter transcript. A scroll
  // (the reader's wheel, keys, finger or scrollbar, a drag carried past the chat's edge, Jump to
  // latest) moves the view as it always does, and the row is held where it then is. Let go, the
  // room goes and a reader still following is put at the end.
  const pressing = useRef<string | null>(null);
  const selectedKeys = useRef<readonly string[]>([]);
  // the held row, where it is on screen, and where the view was when the hold last heard it
  const anchor = useRef<{ key: string; y: number; top: number } | null>(null);
  const room = useRef<string | null>(null);
  const rowTop = useCallback((key: string): number | null => {
    const node = scroller.current;
    const row = node?.querySelector<HTMLElement>(`[data-chat-row="${CSS.escape(key)}"]`);
    return node && row ? row.getBoundingClientRect().top - node.getBoundingClientRect().top : null;
  }, [scroller]);
  const keep = useCallback(() => {
    const node = scroller.current, held = anchor.current;
    // A reader away from the end has nothing followed under them: the list holds the rows they
    // read in place itself (maintainVisibleContentPosition), and a second move would undo it.
    if (node === null || held === null || !following.current) return;
    const y = rowTop(held.key);
    if (y === null) return;
    // The view moved since the hold last heard it, and not because the transcript got too short
    // for where it was: that is a scroll whose event has not come yet (a wheel, Jump to latest),
    // and it stands. The row is held where it is now.
    const max = node.scrollHeight - node.clientHeight;
    const clamped = held.top > max && Math.abs(node.scrollTop - max) <= 1;
    if (Math.abs(node.scrollTop - held.top) > 1 && !clamped) { held.y = y; held.top = node.scrollTop; return; }
    const moved = y - held.y;
    if (Math.abs(moved) < 1) return;
    const target = node.scrollTop + moved;
    const short = target - max;
    const content = node.querySelector<HTMLElement>(".chat-transcript-virtual");
    if (short > 0 && content !== null) {
      // the list sets its own min-height inline: it is given back when the hold ends
      room.current ??= content.style.minHeight;
      content.style.minHeight = `${content.offsetHeight + Math.ceil(short)}px`;
    }
    node.scrollTop = target;
    held.y = rowTop(held.key) ?? y;
    held.top = node.scrollTop;
    // the chat reads this move as the timeline's own, not the reader's (a drag's pointer moves
    // would otherwise make one up a reader leaving the end)
    onFollowed(node.scrollTop);
  }, [scroller, rowTop, following, onFollowed]);
  const keepQueued = useRef(false);
  const keepMeasured = useCallback(() => {
    if (keepQueued.current) return;
    keepQueued.current = true;
    // after the list's own microtask has drawn the measured rows, as followMeasured
    queueMicrotask(() => { keepQueued.current = false; keep(); });
  }, [keep]);
  const hold = useCallback(() => {
    const keys = selectedKeys.current;
    const next = pressing.current !== null || keys.length > 0;
    if (next) {
      if (!selecting.current) dropPendingListScroll(listRef.current);
      selecting.current = true;
      // The row pressed holds; a press between rows holds the first row its selection reaches.
      // A held row the selection still takes in stays held (a drag carried up into the rows
      // above it), and one it has left gives way to the first row selected.
      const current = anchor.current?.key;
      const key = pressing.current || (current !== undefined && keys.includes(current) ? current : keys[0]);
      if (key && current !== key) {
        const y = rowTop(key), node = scroller.current;
        anchor.current = y === null || node === null ? null : { key, y, top: node.scrollTop };
      }
      return;
    }
    if (!selecting.current) return;
    selecting.current = false;
    anchor.current = null;
    const content = scroller.current?.querySelector<HTMLElement>(".chat-transcript-virtual");
    if (content && room.current !== null) content.style.minHeight = room.current;
    room.current = null;
    followMeasured();
  }, [selecting, listRef, scroller, rowTop, followMeasured]);
  const held = useRef(hold);
  held.current = hold;
  // what a render changes under a held selection (the Working line going, a row's last words) is
  // held back as soon as it is committed, before anything reads the layout
  useLayoutEffect(() => { if (anchor.current !== null) keep(); }, [rows, header, footer, keep]);
  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    // the layout's moves are held back where they are made (the layout effect above, the list's
    // measurements, the observers): a scroll that comes to be heard is a move of the view itself
    const scrolled = () => {
      const held = anchor.current;
      if (held === null) return;
      held.y = rowTop(held.key) ?? held.y;
      held.top = node.scrollTop;
    };
    const resized = new ResizeObserver(() => { if (anchor.current !== null) keep(); });
    const content = node.querySelector<HTMLElement>(".chat-transcript-virtual");
    if (content !== null) resized.observe(content);
    node.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      resized.disconnect();
      node.removeEventListener("scroll", scrolled);
      // the chat outlives a timeline (its source can change): no hold is left behind
      selecting.current = false;
      anchor.current = null;
    };
  }, [scroller, keep, rowTop, selecting]);

  // The footer (a sent message's bubble, the Working line) is no row: no item size change reports
  // its growth, and a scroll to the end asked for before the list measured it stops short of it,
  // under the composer. A reader following the end is put there before the grown footer is
  // painted, and that short aim is dropped.
  const footerRef = useCallback((box: HTMLDivElement) => {
    let height = box.offsetHeight;
    const observer = new ResizeObserver(() => {
      const grew = box.offsetHeight > height;
      height = box.offsetHeight;
      const node = scroller.current;
      // held under a selection: a shrunk footer moves nothing either
      if (selecting.current) { keep(); return; }
      if (!grew || node === null || !following.current || manualLayout.current) return;
      dropPendingListScroll(listRef.current);
      node.scrollTop = node.scrollHeight;
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [scroller, listRef, following, manualLayout, selecting, keep]);

  useLayoutEffect(() => {
    const transcript = scroller.current?.querySelector<HTMLElement>(".chat-transcript");
    if (transcript) {
      if (source === undefined) delete transcript.dataset.conversationSource;
      else transcript.dataset.conversationSource = source;
    }
  }, [source, scroller]);

  const rendered = useCallback(({ item, index }: { item: Row; index: number }) => {
    let memory = memories.get(item.key);
    if (!memory) {
      memory = { toggles: new Map(), outputs: new Map(), runs: new Map(), dormant: new Map() };
      memories.set(item.key, memory);
    }
    return <ChatRowMemoryContext.Provider value={memory}>
      <div data-chat-row={item.key} className={item.beforeUser ? "chat-virtual-row is-before-user" : "chat-virtual-row"}>{renderRow(item, index)}</div>
    </ChatRowMemoryContext.Provider>;
  }, [memories, renderRow]);

  return <LegendList
    ref={attachList}
    className="chat-view chat-view-virtual"
    contentContainerClassName="chat-transcript chat-transcript-virtual"
    role="log"
    aria-live="polite"
    aria-label={label}
    data-conversation-source={source}
    data-chat-virtual=""
    data-chat-pinned={pinned.length}
    dataKey={scope}
    data={rows}
    extraData={extraData}
    keyExtractor={(row) => row.key}
    renderItem={rendered}
    estimatedItemSize={120}
    drawDistance={400}
    recycleItems={false}
    initialScrollAtEnd
    maintainVisibleContentPosition
    alwaysRender={{ keys: pinned }}
    ListHeaderComponent={<div className="chat-virtual-header">{header}</div>}
    ListFooterComponent={<div ref={footerRef} className="chat-virtual-footer">{footer}</div>}
    onScroll={heard}
    onLoad={() => { if (following.current) listRef.current?.scrollToEnd({ animated: false }); }}
    onItemSizeChanged={() => {
      if (selecting.current) keepMeasured();
      else if (following.current && !manualLayout.current) followMeasured();
    }}
  />;
}
