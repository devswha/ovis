import { expect, test } from "bun:test";
import { useRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../shared/machines.ts";
import { getTransport, setTransport, CarrierDownError } from "./transport.ts";
import { useRosterLoader, CARRIER_GRACE_MS } from "./useMachineRoster.ts";

test("a healthy pushed roster overtaking the recovery read cancels the carrier error", async () => {
  const original = getTransport();
  const saved = new Map(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const timers = new Map<number, { run: () => void; ms: number }>();
  let sequence = 0;
  const noop = () => {};
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hash: "" },
    setTimeout(run: () => void, ms: number) { timers.set(++sequence, { run, ms }); return sequence; }, clearTimeout: (id: number) => timers.delete(id), setInterval: () => ++sequence, clearInterval: noop } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", addEventListener: noop, removeEventListener: noop, querySelector: () => null } });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  let carrierUp = false, reads = 0, shown: string | null = null;
  const replay = Promise.withResolvers<Response>();
  setTransport({ ...original, async fetch() { reads++; if (!carrierUp) throw new CarrierDownError(); return replay.promise; } });
  const local: Machine = { id: "local", kind: "local", name: "This PC", state: "connected", enabled: true, error: null, snapshot: null };
  let loader!: ReturnType<typeof useRosterLoader>;
  const loadHealth = async () => {};
  function Probe() {
    loader = useRosterLoader({ locked: false, healthFailing: false, rosterIn: noop, setMachines: noop, setMachineRosterLoaded: noop,
      setError: (value) => { shown = typeof value === "function" ? value(shown) : value; }, setLocked: noop, loadHealth,
      lockedRef: useRef(false), refetchTimer: useRef(null) });
    return null;
  }
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(<Probe />); });
    expect([...timers.values()].some((timer) => timer.ms === CARRIER_GRACE_MS)).toBe(true);
    carrierUp = true;
    await act(async () => { loader.onRosterStream("opened"); });
    expect(reads).toBe(2);
    await act(async () => {
      loader.snapshotRequests.current.invalidate();
      loader.onRosterStream([local]);
      replay.resolve(Response.json({ machines: [local] }));
    });
    await act(async () => { for (const { ms, run } of timers.values()) if (ms === CARRIER_GRACE_MS) run(); });
    expect(shown).toBeNull();
  } finally {
    await act(async () => renderer?.unmount());
    setTransport(original);
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
