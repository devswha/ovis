import { expect, test } from "bun:test";
import { useRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine, DevicePairedEvent } from "../../shared/machines.ts";
import { readLink } from "./deepLink.ts";
import { setPcNewness } from "./relay/newPcHere.ts";
import { useSelectTarget } from "./useSelection.ts";
import { usePairedNotices } from "./usePairedNotices.ts";

test("a workspace-only bookmark does not pick an exact session on a new PC", async () => {
  const picked: (string | null)[] = [];
  const machine = { id: "local", state: "connected", snapshot: { workspaces: [{ workspace_id: "1", label: "alpha" }], panes: [{ pane_id: "p1", workspace_id: "1", focused: true }], focused_pane_id: "p1", layouts: [] } } as unknown as Machine;
  const none = () => {};
  function Probe() {
    useSelectTarget({ selectedMachineId: "local", selectedMachine: machine, selectedPaneId: null, snapshot: machine.snapshot,
      setSelectedPaneId: (next) => picked.push(typeof next === "function" ? next(null) : next),
      pendingLink: useRef(readLink("?ws=1")), pendingFile: useRef(null), selectionHint: useRef(null), selectionSince: useRef(0), rosterSeq: useRef(0),
      movingPanes: useRef(new Set<string>()), linkTick: 0, setConnected: none, setConnectedBefore: none, setSelectedMachineId: none,
      setDrawerOpen: none, setOutputStopped: none, setNotificationViewTarget: none, setAutoSelected: none, setTerminalPeek: none, setHeaderNote: none, setLinkLanded: none,
    } as Parameters<typeof useSelectTarget>[0]);
    return null;
  }
  let renderer: ReactTestRenderer | undefined;
  setPcNewness({ until: Date.now() + 3_600_000 });
  try {
    await act(async () => { renderer = create(<Probe />); });
    expect(picked.filter((pane) => pane !== null)).toEqual([]);
  } finally {
    await act(async () => renderer?.unmount());
    setPcNewness(null);
  }
});

test("a watching page without storage remembers both dismissed joins across replay", async () => {
  const event = (id: string): DevicePairedEvent => ({ type: "device-paired", event_id: id, device_id: id, label: id, enrolled_at: "2026-11-21T03:00:00Z" });
  const first = event("A"), second = event("B");
  let notices!: ReturnType<typeof usePairedNotices>;
  function Probe() { notices = usePairedNotices(false, true); return null; }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { get localStorage() { throw new Error("Storage denied"); } } });
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(<Probe />); });
    await act(async () => notices.setPairedNotices([first, second]));
    await act(async () => notices.dismissPairedNotice(first));
    await act(async () => notices.dismissPairedNotice(second));
    await act(async () => notices.setPairedNotices([first, second]));
    expect(notices.pairedNotices.map((join) => join.event_id)).toEqual([]);
  } finally {
    await act(async () => renderer?.unmount());
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window");
  }
});
