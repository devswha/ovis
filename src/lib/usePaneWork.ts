import { useCallback, useEffect, useState } from "react";

import type { PaneTasksRead, PlanRead } from "./api.ts";
import { useMachineApi } from "./machineContext.tsx";
import { clockOffsetMs } from "./omoTasks.ts";
import type { OmoRun, OmoTask, PlanStep } from "../../shared/protocol.ts";

export const WORK_POLL_MS = 3000;

/**
 * Asks again every WORK_POLL_MS while `active`, the first time at once. An answer that lands after
 * the loop was stopped is dropped. `read`, `apply` and `fail` are the loop's identity: a new one
 * restarts it.
 */
function usePoll<T>(active: boolean, read: () => Promise<T>, apply: (answer: T, received: number) => void, fail: () => void): void {
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const answer = await read();
        if (!alive) return;
        apply(answer, Date.now());
      } catch {
        if (alive) fail();
      }
      if (alive) timer = setTimeout(() => void load(), WORK_POLL_MS);
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [active, read, apply, fail]);
}

export interface PaneTasksState {
  /** null until the PC has answered */
  tasks: OmoTask[] | null;
  runs: OmoRun[];
  moreRunning: number;
  /** the last read failed: said until one succeeds */
  failed: boolean;
  /** the PC's clock as of the last answer: the time the rows' spans run to */
  at: number;
  /** goes back to not having been read, as for a pane's first look */
  forget: () => void;
}

/** The tasks the PC lists for the pane (GET /api/pane/omo-tasks), read while `active`; what was read stays while it is not. */
export function usePaneTasks(paneId: string, active: boolean): PaneTasksState {
  const { fetchPaneOmoActivity } = useMachineApi();
  const [tasks, setTasks] = useState<OmoTask[] | null>(null);
  const [runs, setRuns] = useState<OmoRun[]>([]);
  const [moreRunning, setMoreRunning] = useState(0);
  const [failed, setFailed] = useState(false);
  const [at, setAt] = useState(() => Date.now());
  const read = useCallback(() => fetchPaneOmoActivity(paneId), [fetchPaneOmoActivity, paneId]);
  const apply = useCallback((next: PaneTasksRead, received: number) => {
    setTasks(next.tasks); setRuns(next.runs); setMoreRunning(next.moreRunning); setFailed(false); setAt(received + clockOffsetMs(next.serverTime, received));
  }, []);
  const fail = useCallback(() => setFailed(true), []);
  const forget = useCallback(() => { setTasks(null); setRuns((kept) => kept.length === 0 ? kept : []); setMoreRunning(0); }, []);
  usePoll(active, read, apply, fail);
  return { tasks, runs, moreRunning, failed, at, forget };
}

export interface PanePlanState {
  /** undefined until the PC has answered; null when the session keeps no plan */
  steps: PlanStep[] | null | undefined;
  failed: boolean;
  at: number;
  forget: () => void;
}

/** The plan the PC reads from the pane's session (GET /api/pane/plan), read while `active`; what was read stays while it is not. */
export function usePanePlan(paneId: string, active: boolean): PanePlanState {
  const { fetchPanePlan } = useMachineApi();
  const [steps, setSteps] = useState<PlanStep[] | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [at, setAt] = useState(() => Date.now());
  const read = useCallback(() => fetchPanePlan(paneId), [fetchPanePlan, paneId]);
  const apply = useCallback((next: PlanRead, received: number) => {
    setSteps(next.steps); setFailed(false); setAt(received + clockOffsetMs(next.serverTime, received));
  }, []);
  const fail = useCallback(() => setFailed(true), []);
  const forget = useCallback(() => setSteps(undefined), []);
  usePoll(active, read, apply, fail);
  return { steps, failed, at, forget };
}
