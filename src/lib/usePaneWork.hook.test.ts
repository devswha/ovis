import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { PaneTasksRead, PlanRead } from "./api.ts";
import * as machineContext from "./machineContext.tsx";
import { usePanePlan, usePaneTasks, WORK_POLL_MS, type PanePlanState, type PaneTasksState } from "./usePaneWork.ts";
import type { OmoTask, PlanStep } from "../../shared/protocol.ts";

const SERVER = "2026-10-02T05:04:12.000Z";
const task = (id: string): OmoTask => ({ id, title: `task ${id}`, category: null, model: null, status: "running", started_at: "2026-10-02T05:00:00Z", ended_at: null, turns: null, tool_calls: null, tokens: null, detail_kind: null });
const step = (id: string): PlanStep => ({ id, label: `step ${id}`, active: null, status: "pending", blocked_by: [], owner: null, started_at: null, ended_at: null });
const listed = (...tasks: OmoTask[]): PaneTasksRead => ({ tasks, runs: [], serverTime: SERVER, moreRunning: 0 });
const planned = (...steps: PlanStep[]): PlanRead => ({ steps, serverTime: SERVER });

const fetchPaneOmoActivity = mock(async (_pane: string): Promise<PaneTasksRead> => listed());
const fetchPanePlan = mock(async (_pane: string): Promise<PlanRead> => planned());

type Out<T> = { current: T | null };
function TasksProbe({ paneId, active, out }: { paneId: string; active: boolean; out: Out<PaneTasksState> }) {
  out.current = usePaneTasks(paneId, active);
  return null;
}
function PlanProbe({ paneId, active, out }: { paneId: string; active: boolean; out: Out<PanePlanState> }) {
  out.current = usePanePlan(paneId, active);
  return null;
}

describe("the plan and task reads", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    descriptors.set("IS_REACT_ACT_ENVIRONMENT", Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    fetchPaneOmoActivity.mockClear();
    fetchPanePlan.mockClear();
    // only the two reads the hooks make
    spyOn(machineContext, "useMachineApi").mockReturnValue({ fetchPaneOmoActivity, fetchPanePlan } as never);
    jest.useFakeTimers();
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    jest.useRealTimers();
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const show = async (element: ReactElement): Promise<void> => { await act(async () => { renderer = create(element); }); };
  const update = async (element: ReactElement): Promise<void> => { await act(async () => { renderer!.update(element); }); };
  const later = async (): Promise<void> => { await act(async () => { jest.runOnlyPendingTimers(); }); };

  describe("usePaneTasks", () => {
    it("asks at once while active, again every WORK_POLL_MS, and stops the moment it is not active", async () => {
      const out: Out<PaneTasksState> = { current: null };
      await show(createElement(TasksProbe, { paneId: "p1", active: true, out }));
      expect(fetchPaneOmoActivity).toHaveBeenCalledTimes(1);
      expect(fetchPaneOmoActivity).toHaveBeenCalledWith("p1");
      expect(WORK_POLL_MS).toBe(3000);
      await later();
      expect(fetchPaneOmoActivity).toHaveBeenCalledTimes(2);
      await update(createElement(TasksProbe, { paneId: "p1", active: false, out }));
      expect(jest.getTimerCount()).toBe(0);
      await later();
      expect(fetchPaneOmoActivity).toHaveBeenCalledTimes(2);
    });

    it("asks nothing while it is not active", async () => {
      const out: Out<PaneTasksState> = { current: null };
      await show(createElement(TasksProbe, { paneId: "p1", active: false, out }));
      expect(fetchPaneOmoActivity).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      expect(out.current?.tasks).toBeNull();
    });

    it("asks about the pane it is given, and again when it is given another", async () => {
      const out: Out<PaneTasksState> = { current: null };
      await show(createElement(TasksProbe, { paneId: "p1", active: true, out }));
      await update(createElement(TasksProbe, { paneId: "p2", active: true, out }));
      expect(fetchPaneOmoActivity.mock.calls.map((call) => call[0])).toEqual(["p1", "p2"]);
    });

    it("keeps what it read while it is not active, and shows it again as it asks again", async () => {
      const out: Out<PaneTasksState> = { current: null };
      fetchPaneOmoActivity.mockImplementationOnce(async () => listed(task("a")));
      await show(createElement(TasksProbe, { paneId: "p1", active: true, out }));
      expect(out.current?.tasks?.map((item) => item.id)).toEqual(["a"]);
      await update(createElement(TasksProbe, { paneId: "p1", active: false, out }));
      expect(out.current?.tasks?.map((item) => item.id)).toEqual(["a"]);
      fetchPaneOmoActivity.mockImplementationOnce(async () => listed(task("a"), task("b")));
      await update(createElement(TasksProbe, { paneId: "p1", active: true, out }));
      expect(out.current?.tasks?.map((item) => item.id)).toEqual(["a", "b"]);
    });

    it("counts the time on the PC's clock, whatever this device's says", async () => {
      const out: Out<PaneTasksState> = { current: null };
      await show(createElement(TasksProbe, { paneId: "p1", active: true, out }));
      expect(out.current?.at).toBe(Date.parse(SERVER));
    });

    it("hands on the tasks it could not list, and what the PC left out", async () => {
      const out: Out<PaneTasksState> = { current: null };
      fetchPaneOmoActivity.mockImplementationOnce(async () => ({ tasks: [task("a")], runs: [], serverTime: null, moreRunning: 4 }));
      await show(createElement(TasksProbe, { paneId: "p1", active: true, out }));
      expect(out.current?.moreRunning).toBe(4);
    });

    it("says a failed read until one succeeds, and asks again meanwhile", async () => {
      const out: Out<PaneTasksState> = { current: null };
      fetchPaneOmoActivity.mockImplementationOnce(async () => { throw new Error("offline"); });
      await show(createElement(TasksProbe, { paneId: "p1", active: true, out }));
      expect(out.current).toMatchObject({ failed: true, tasks: null });
      await later();
      expect(out.current).toMatchObject({ failed: false });
      expect(fetchPaneOmoActivity).toHaveBeenCalledTimes(2);
    });

    it("drops an answer that lands after it stopped asking", async () => {
      const out: Out<PaneTasksState> = { current: null };
      const reply = Promise.withResolvers<PaneTasksRead>();
      fetchPaneOmoActivity.mockImplementationOnce(() => reply.promise);
      await show(createElement(TasksProbe, { paneId: "p1", active: true, out }));
      await update(createElement(TasksProbe, { paneId: "p1", active: false, out }));
      await act(async () => { reply.resolve(listed(task("late"))); });
      expect(out.current?.tasks).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    });

    it("goes back to a first look on forget, as for a pane not read yet", async () => {
      const out: Out<PaneTasksState> = { current: null };
      fetchPaneOmoActivity.mockImplementationOnce(async () => ({ tasks: [task("a")], runs: [], serverTime: SERVER, moreRunning: 2 }));
      await show(createElement(TasksProbe, { paneId: "p1", active: true, out }));
      expect(out.current?.tasks).toHaveLength(1);
      await update(createElement(TasksProbe, { paneId: "p1", active: false, out }));
      await act(async () => { out.current?.forget(); });
      expect(out.current).toMatchObject({ tasks: null, moreRunning: 0 });
    });
  });

  describe("usePanePlan", () => {
    it("asks at once while active, again every WORK_POLL_MS, and stops the moment it is not active", async () => {
      const out: Out<PanePlanState> = { current: null };
      await show(createElement(PlanProbe, { paneId: "p1", active: true, out }));
      expect(fetchPanePlan).toHaveBeenCalledTimes(1);
      expect(fetchPanePlan).toHaveBeenCalledWith("p1");
      await later();
      expect(fetchPanePlan).toHaveBeenCalledTimes(2);
      await update(createElement(PlanProbe, { paneId: "p1", active: false, out }));
      expect(jest.getTimerCount()).toBe(0);
      await later();
      expect(fetchPanePlan).toHaveBeenCalledTimes(2);
    });

    it("tells a plan not read yet from a session that keeps none", async () => {
      const out: Out<PanePlanState> = { current: null };
      const reply = Promise.withResolvers<PlanRead>();
      fetchPanePlan.mockImplementationOnce(() => reply.promise);
      await show(createElement(PlanProbe, { paneId: "p1", active: true, out }));
      expect(out.current?.steps).toBeUndefined();
      await act(async () => { reply.resolve({ steps: null, serverTime: SERVER }); });
      expect(out.current?.steps).toBeNull();
    });

    it("keeps the steps while it is not active, and the PC's clock with them", async () => {
      const out: Out<PanePlanState> = { current: null };
      fetchPanePlan.mockImplementationOnce(async () => planned(step("a"), step("b")));
      await show(createElement(PlanProbe, { paneId: "p1", active: true, out }));
      await update(createElement(PlanProbe, { paneId: "p1", active: false, out }));
      expect(out.current?.steps?.map((item) => item.id)).toEqual(["a", "b"]);
      expect(out.current?.at).toBe(Date.parse(SERVER));
    });

    it("forgets the steps on request and keeps saying a failed read, as the chip's list opens on a plan not read yet", async () => {
      const out: Out<PanePlanState> = { current: null };
      fetchPanePlan.mockImplementationOnce(async () => planned(step("a")));
      await show(createElement(PlanProbe, { paneId: "p1", active: true, out }));
      fetchPanePlan.mockImplementationOnce(async () => { throw new Error("offline"); });
      await later();
      expect(out.current).toMatchObject({ failed: true });
      expect(out.current?.steps).toHaveLength(1);
      await update(createElement(PlanProbe, { paneId: "p1", active: false, out }));
      await act(async () => { out.current?.forget(); });
      expect(out.current?.steps).toBeUndefined();
      expect(out.current?.failed).toBe(true);
    });

    it("drops an answer that lands after it stopped asking", async () => {
      const out: Out<PanePlanState> = { current: null };
      const reply = Promise.withResolvers<PlanRead>();
      fetchPanePlan.mockImplementationOnce(() => reply.promise);
      await show(createElement(PlanProbe, { paneId: "p1", active: true, out }));
      await update(createElement(PlanProbe, { paneId: "p1", active: false, out }));
      await act(async () => { reply.resolve(planned(step("late"))); });
      expect(out.current?.steps).toBeUndefined();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
