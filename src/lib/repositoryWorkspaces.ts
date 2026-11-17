import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import type { SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";

const answers = new Map<string, Map<string, boolean>>();
const asking = new Map<string, Promise<void>>();
const rounds = new Map<string, number>();
const listeners = new Set<() => void>();
const lifetimes = new Map<string, string | undefined>();
const NOT_ANSWERED = new Set(["closed", "socket_error", "bad_frame", "cancelled"]);
const readers = new Map<string, number>();
const unanswered = new Map<string, { asked: string; ids: Set<string> }>();
const NONE: ReadonlySet<string> = new Set();

function told(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function answersOf(machineId: string): Map<string, boolean> {
  let known = answers.get(machineId);
  if (!known) answers.set(machineId, known = new Map());
  return known;
}

function answersFrom(machineId: string, lifetime: string | undefined): ReadonlyMap<string, boolean> | undefined {
  return lifetimes.get(machineId) === lifetime ? answers.get(machineId) : undefined;
}

export function worktreesStartHere(machineId: string, workspace: WorkspaceInfo, lifetime: string | undefined): boolean {
  if (workspace.worktree) return !workspace.worktree.is_linked_worktree;
  return answersFrom(machineId, lifetime)?.get(workspace.workspace_id) === true;
}

function dropAnswers(machineId: string): void {
  answers.delete(machineId);
  unanswered.delete(machineId);
  rounds.set(machineId, (rounds.get(machineId) ?? 0) + 1);
}

function ask(machineId: string, workspaceId: string, listWorktrees: (workspace: string) => Promise<unknown>): Promise<void> {
  const round = rounds.get(machineId) ?? 0;
  const key = `${machineId}\n${round}\n${workspaceId}`;
  const running = asking.get(key);
  if (running) return running;
  const current = (): boolean => (rounds.get(machineId) ?? 0) === round;
  const kept = (answer: boolean): void => { if (current()) answersOf(machineId).set(workspaceId, answer); };
  const question = listWorktrees(workspaceId).then(
    () => kept(true),
    (error: unknown) => {
      if (error instanceof ApiError && error.status < 500 && !NOT_ANSWERED.has(error.code ?? "")) kept(false);
      else if (current()) unanswered.get(machineId)?.ids.add(workspaceId);
    },
  ).finally(() => { if (asking.get(key) === question) asking.delete(key); });
  asking.set(key, question);
  return question;
}

export function useRepositoryWorkspaces({ machineId, snapshot, online, watching, offered, listWorktrees }: {
  machineId: string;
  snapshot: SessionSnapshot | null | undefined;
  online: boolean;
  watching: boolean;
  offered: boolean;
  listWorktrees: (workspace: string) => Promise<unknown>;
}): { repositoryWorkspaces: ReadonlySet<string>; notCheckout: (workspaceId: string) => void } {
  const unmarked = [...new Set((snapshot?.workspaces ?? []).filter((workspace) => !workspace.worktree).map((workspace) => workspace.workspace_id))].sort().join("\n");
  const asked = !online || unmarked === "" || watching || !offered ? null : unmarked;
  const lifetime = snapshot?.herdr_lifetime;
  const shown = useRef(NONE);
  const read = useCallback((): ReadonlySet<string> => {
    const known = answersFrom(machineId, lifetime);
    const next = asked === null || !known ? [] : asked.split("\n").filter((id) => known.get(id) === true);
    if (next.length !== shown.current.size || !next.every((id) => shown.current.has(id))) shown.current = new Set(next);
    return shown.current;
  }, [machineId, asked, lifetime]);
  const repositoryWorkspaces = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    readers.set(machineId, (readers.get(machineId) ?? 0) + 1);
    return () => {
      const left = (readers.get(machineId) ?? 1) - 1;
      if (left > 0) { readers.set(machineId, left); return; }
      readers.delete(machineId);
      lifetimes.delete(machineId);
      dropAnswers(machineId);
    };
  }, [machineId]);
  useEffect(() => {
    if (asked === null) {
      dropAnswers(machineId);
      told();
      return;
    }
    if (lifetimes.has(machineId) && lifetimes.get(machineId) !== lifetime) dropAnswers(machineId);
    lifetimes.set(machineId, lifetime);
    const known = answersOf(machineId);
    const ids = asked.split("\n");
    for (const id of [...known.keys()]) if (!ids.includes(id)) known.delete(id);
    let record = unanswered.get(machineId);
    if (record?.asked !== asked) unanswered.set(machineId, record = { asked, ids: new Set() });
    const failed = record.ids;
    told();
    for (const id of ids.filter((id) => !known.has(id) && !failed.has(id))) void ask(machineId, id, listWorktrees).then(told);
  }, [machineId, asked, lifetime, listWorktrees]);
  const notCheckout = useCallback((workspaceId: string) => {
    answersOf(machineId).set(workspaceId, false);
    told();
  }, [machineId]);
  return { repositoryWorkspaces, notCheckout };
}
