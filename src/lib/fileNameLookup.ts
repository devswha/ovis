import { createContext, useMemo } from "react";

import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { ApiError } from "./api.ts";
import { fileLineTarget } from "./filePaths.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";

export interface FileNameLookup {
  known(name: string): boolean | undefined;
  ask(name: string): Promise<boolean>;
}

export const FileNameLookupContext = createContext<FileNameLookup | null>(null);

const KEPT_MS = 60_000;
const KEPT = 500;
const RUNNING = 4;
const ANSWER_MS = 10_000;

interface Kept { at: number; turn: unknown; found: Promise<boolean>; answer?: boolean }
const answers = new Map<string, Kept>();
let running = 0;
const waiting: Array<() => void> = [];

async function inSlot<T>(work: () => Promise<T>, late: T): Promise<T> {
  let expired = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const run = (async () => {
    if (running < RUNNING) running++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return expired ? late : await work();
    } finally {
      const next = waiting.shift();
      if (next) next(); else running--;
    }
  })();
  try {
    return await Promise.race([run, new Promise<T>((resolve) => { deadline = setTimeout(() => { expired = true; resolve(late); }, ANSWER_MS); })]);
  } finally {
    clearTimeout(deadline);
  }
}

async function opens(name: string, stat: (name: string) => Promise<unknown>, folder: ((name: string) => Promise<unknown>) | null): Promise<boolean> {
  try {
    await stat(name);
    return true;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404 || error.code !== "not_found") return true;
  }
  if (folder === null) return false;
  try {
    await folder(name);
    return true;
  } catch (error) {
    return !(error instanceof ApiError && error.status === 400);
  }
}

export function createFileNameLookup(scope: string, turn: unknown, stat: (name: string) => Promise<unknown>, folder: ((name: string) => Promise<unknown>) | null): FileNameLookup {
  const key = (name: string) => `${scope}\0${fileLineTarget(name).path}`;
  const kept = (name: string) => {
    const entry = answers.get(key(name));
    return entry !== undefined && Date.now() - entry.at < KEPT_MS && (entry.answer === true || entry.turn === turn) ? entry : undefined;
  };
  return {
    known: (name) => kept(name)?.answer,
    ask: (name) => {
      const known = kept(name);
      if (known !== undefined) return known.found;
      const entry = { at: Date.now(), turn } as Kept;
      entry.found = inSlot(() => opens(fileLineTarget(name).path, stat, folder), true).then((answer) => entry.answer = answer);
      answers.delete(key(name));
      answers.set(key(name), entry);
      if (answers.size > KEPT) answers.delete(answers.keys().next().value!);
      return entry.found;
    },
  };
}

export function useFileNameLookup(paneId: string, cwd: string | null, turn: unknown): FileNameLookup {
  const machineId = useMachineId();
  const { fetchFileInfo, fetchDirectories } = useMachineApi();
  return useMemo(() => createFileNameLookup(`${machineId}\0${paneId}\0${cwd ?? ""}`, turn, (name) => fetchFileInfo(name, paneId),
    machineId === LOCAL_MACHINE ? (name) => fetchDirectories(name, false, true, paneId) : null),
  [machineId, paneId, cwd, turn, fetchFileInfo, fetchDirectories]);
}
