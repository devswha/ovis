import { paneStorageId } from "../../shared/machines.ts";
import { moveChatPosition } from "./chatScrollMemory.ts";
import { pendingMessages } from "./pendingMessages.ts";
import { currentSidebarPins, movedSidebarPins, setSidebarPins } from "./sidebarPins.ts";
import { composerDrafts, sendLease, underSendLock, type ComposerDraftStore } from "./composerDraft.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { PANE_VIEW_KEY_PREFIX } from "./settings.ts";
import { REPLY_COMMENTS_PREFIX, replyComments, type ReplyCommentStore } from "./replyComments.ts";
import { readTerminalDraft, terminalDraftSending, writeTerminalDraft } from "./terminalDraft.ts";

type KeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const CARRIED = ["ovis:terminal-draft:", PANE_VIEW_KEY_PREFIX];

export function carryPaneState(machineId: string, from: string, to: string, drafts: ComposerDraftStore = composerDrafts, storage: () => KeyStorage = () => paneLifetimes.paneStorage,
  comments: ReplyCommentStore = replyComments): void {
  const before = paneStorageId(machineId, from);
  const after = paneStorageId(machineId, to);
  underSendLock(`ovis:composer-draft:${before}`, () => {
    const draft = `ovis:composer-draft:${before}`;
    const lease = sendLease(storage(), draft);
    comments.move(REPLY_COMMENTS_PREFIX + before, REPLY_COMMENTS_PREFIX + after, lease && { draft, at: lease.at });
    if (lease !== null) {
      drafts.refresh(draft);
      const unsubscribe = drafts.subscribe(() => {
        if (drafts.read(draft).sending) return;
        unsubscribe();
        comments.refresh();
      });
    }
    drafts.move(`ovis:composer-draft:${before}`, `ovis:composer-draft:${after}`);
  });
  const line = readTerminalDraft(before);
  if (line && !terminalDraftSending(before) && !readTerminalDraft(after)) {
    writeTerminalDraft(after, line);
    writeTerminalDraft(before, "");
  }
  for (const prefix of CARRIED) {
    try {
      const value = storage().getItem(prefix + before);
      if (value === null || storage().getItem(prefix + after) !== null) continue;
      storage().setItem(prefix + after, value);
      storage().removeItem(prefix + before);
    } catch {}
  }
}

export function carryMovedPane(machineId: string, from: string, to: string): void {
  if (from === to) return;
  carryPaneState(machineId, from, to);
  const before = paneStorageId(machineId, from), after = paneStorageId(machineId, to);
  pendingMessages.move(before, after);
  moveChatPosition(before, after);
  setSidebarPins(movedSidebarPins(currentSidebarPins(), machineId, from, to));
}

type PaneTarget = { machineId: string; paneId: string };

export function movedView<S extends { panes: Record<string, PaneTarget> }>(selection: { machineId: string | null; paneId: string | null }, split: S | null, machineId: string, from: string, to: string): { selection: string | null; split: S | null } {
  const moved = split === null ? [] : Object.entries(split.panes).filter(([, pane]) => pane.machineId === machineId && pane.paneId === from);
  return {
    selection: selection.machineId === machineId && selection.paneId === from ? to : null,
    split: split !== null && moved.length > 0 ? { ...split, panes: { ...split.panes, ...Object.fromEntries(moved.map(([slot]) => [slot, { machineId, paneId: to }])) } } : null,
  };
}
