import { expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";
import { DeviceStore } from "../devices.ts";
import type { MachineRelay } from "../machine-relay.ts";
import { crossingMs, OUTPUT_HARD_BYTES, OUTPUT_JOIN_MAX_MS, OUTPUT_LOW_BYTES, OUTPUT_STALL_MS } from "../output-window.ts";
import type { PendingInputs } from "../pending-input.ts";
import type { MachineEventDocument } from "../machine-events.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { SharedPreferences } from "../../shared/preferences.ts";
import { backlog, type Client, connectionData, connectionOf, createConnections, machineEventsAhead, send, setMachineEvents } from "./connections.ts";

function harness({ deviceId, readOnly = false, relay, revokedAlready = false, store, machineEvents }: { deviceId?: string; readOnly?: boolean; relay?: MachineRelay; revokedAlready?: boolean; store?: DeviceStore; machineEvents?: MachineEventDocument } = {}) {
  const log: string[] = [];
  const revocations: (() => void)[] = [];
  const devices = store ?? {
    onRevoke: (_id: string, close: () => void) => {
      if (revokedAlready) close(); else revocations.push(close);
      return () => log.push("unwatch device");
    },
  } as unknown as DeviceStore;
  const pending = { close: () => log.push("pending closed") } as unknown as PendingInputs<Client, never>;
  const client = {
    data: connectionData({ deviceId, readOnly, ...(relay ? { relay } : {}), ...(machineEvents ? { machineEvents } : {}) }),
    readyState: WebSocket.OPEN,
    close: (code?: number, reason?: string) => log.push(`closed ${code} ${reason}`),
    getBufferedAmount: () => 0,
    send: () => 1,
  };
  const clients = new Set<Client>([client]);
  const present = new Set<Client>([client]);
  const connections = createConnections({
    clients, present, pending, devices,
    detachClaimed: () => log.push("detach claimed"),
    dropClaims: () => log.push("drop claims"),
  });
  return { client, clients, present, log, revoke: () => revocations.forEach((close) => close()), ...connections };
}

it("a stall ends the connection once and leaves its presence to the socket's close", () => {
  const { client, clients, present, log, end } = harness();
  end(client, "stalled");
  end(client, "stalled");
  expect(log).toEqual(["pending closed", "detach claimed", "drop claims", `closed ${OUTPUT_STALLED_CLOSE_CODE} terminal output consumer stalled`]);
  expect(clients.has(client)).toBe(false);
  expect(present.has(client)).toBe(true);
  expect(send(client, { type: "session-changed" })).toBe(0);
  end(client, "closed");
  expect(present.has(client)).toBe(false);
});

it("sends one frame larger than the transport budget and keeps the client while it drains, but not a backlog past the budget (#2566)", () => {
  const { client, log } = harness();
  // the socket queues what it is given and drains from the front only when the test says so
  let buffered = 0;
  const sent: number[] = [];
  Object.assign(client, { getBufferedAmount: () => buffered, send: (raw: string) => { sent.push(raw.length); buffered += Buffer.byteLength(raw); return -1; } });
  const frame = (bytes: number) => ({ type: "error", code: "x", message: "x".repeat(bytes) }) as const;
  const big = frame(OUTPUT_HARD_BYTES);
  const bigBytes = Buffer.byteLength(JSON.stringify(big));
  const half = frame(600 * 1024);
  const halfBytes = Buffer.byteLength(JSON.stringify(half));
  expect(send(client, big)).toBe(-1);
  expect(backlog(client)).toBe(0);
  // what follows the large frame is still sent while it drains, and counts in full
  expect(send(client, half)).toBe(-1);
  expect(backlog(client)).toBe(halfBytes);
  // all but the large frame's last 10 bytes drained: what queued behind it is still a backlog
  buffered -= bigBytes - 10;
  expect(backlog(client)).toBe(halfBytes);
  expect(send(client, half)).toBe(0);
  expect(log).toEqual([`closed ${OUTPUT_STALLED_CLOSE_CODE} terminal output transport stalled`]);
  expect(sent).toHaveLength(2);
});

it("excuses one large frame at a time, and the next once the last has drained", () => {
  const { client, log } = harness();
  let buffered = 0;
  Object.assign(client, { getBufferedAmount: () => buffered, send: (raw: string) => { buffered += Buffer.byteLength(raw); return -1; } });
  const big = { type: "error", code: "x", message: "x".repeat(OUTPUT_HARD_BYTES) } as const;
  expect(send(client, big)).toBe(-1);
  buffered = 0;
  expect(send(client, big)).toBe(-1);
  // a second large frame while one is queued counts in full
  expect(send(client, big)).toBe(0);
  expect(log).toEqual([`closed ${OUTPUT_STALLED_CLOSE_CODE} terminal output transport stalled`]);
});

it("closes a client whose backlog of ordinary frames would pass the transport budget", () => {
  const { client, log } = harness();
  Object.assign(client, { getBufferedAmount: () => OUTPUT_HARD_BYTES - 10 });
  expect(send(client, { type: "error", code: "x", message: "x".repeat(20) })).toBe(0);
  expect(log).toEqual([`closed ${OUTPUT_STALLED_CLOSE_CODE} terminal output transport stalled`]);
});

it("ends the machine-event subscription, never the terminal connection, rather than queue machine events in front of terminal output", () => {
  const listeners = new Set<(preferences: SharedPreferences) => void>();
  const preferences = (bytes: number) => ({ revision: 1, settings: { note: "x".repeat(bytes) } }) as unknown as SharedPreferences;
  let initial = 200;
  const machineEvents: MachineEventDocument = {
    manager: { subscribe: () => () => {} },
    preferences: { get: () => preferences(initial), subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
  };
  const subscribe = (queued: number) => {
    const { client, log } = harness({ machineEvents });
    let buffered = queued;
    const sent: string[] = [];
    Object.assign(client, { getBufferedAmount: () => buffered, send: (raw: string) => { sent.push((JSON.parse(raw) as ServerMessage).type); buffered += Buffer.byteLength(raw); return -1; } });
    setMachineEvents(client, true);
    return { log, sent, queue: (bytes: number) => { buffered = bytes; } };
  };
  // a backlog with no room left even for the ending notice: still told, and the terminal kept
  for (const queued of [OUTPUT_HARD_BYTES - 10, OUTPUT_LOW_BYTES - 100]) {
    const { log, sent } = subscribe(queued);
    expect(log).toEqual([]);
    expect(sent).toEqual(["machine-events-ended"]);
    expect(listeners.size).toBe(0);
  }
  // an empty queue takes a document larger than the low watermark
  initial = OUTPUT_LOW_BYTES * 2;
  const empty = subscribe(0);
  expect(empty.sent).toEqual(["machine-event"]);
  expect(listeners.size).toBe(1);
  // a live event behind a backlog ends the subscription
  empty.queue(OUTPUT_LOW_BYTES - 100);
  for (const listener of [...listeners]) listener(preferences(200));
  expect(empty.log).toEqual([]);
  expect(empty.sent).toEqual(["machine-event", "machine-events-ended"]);
  expect(listeners.size).toBe(0);
});

it("holds off a stall stop while a machine event queued ahead of terminal output may still be crossing the link", () => {
  const { client } = harness();
  let buffered = 0;
  Object.assign(client, { getBufferedAmount: () => buffered, send: (raw: string) => { buffered += Buffer.byteLength(raw); return -1; } });
  // terminal frames grant nothing
  send(client, { type: "error", code: "x", message: "x".repeat(100) });
  expect(machineEventsAhead(client)).toBe(false);
  const before = Date.now();
  // a roster carrying every PC's snapshot, sent onto an empty queue
  buffered = 0;
  send(client, { type: "error", code: "x", message: "x".repeat(200 * 1024) }, () => { throw new Error("not an overflow"); });
  const grace = OUTPUT_STALL_MS + crossingMs(buffered);
  expect(grace).toBeLessThan(OUTPUT_JOIN_MAX_MS);
  expect(machineEventsAhead(client, before + grace - 50)).toBe(true);
  expect(machineEventsAhead(client, Date.now() + grace + 1)).toBe(false);
});

it("never holds off a stall stop for good with a stream of small machine events", () => {
  const { client } = harness();
  let buffered = 0;
  let drained = true;
  Object.assign(client, { getBufferedAmount: () => buffered, send: (raw: string) => { if (!drained) buffered += Buffer.byteLength(raw); return -1; } });
  const start = Date.now();
  try {
    // an event that leaves nothing queued grants nothing
    setSystemTime(new Date(start));
    send(client, { type: "error", code: "x", message: "x" }, () => {});
    expect(machineEventsAhead(client, start)).toBe(false);
    drained = false;
    // a small event every 1.5 s for a minute, each leaving a little queued: the client is open to a stop at least every 10 s
    buffered = 10;
    let lastOpen = start;
    for (let t = 0; t <= 60_000; t += 100) {
      const now = start + t;
      setSystemTime(new Date(now));
      if (t % 1_500 === 0) send(client, { type: "error", code: "x", message: "x" }, () => {});
      if (!machineEventsAhead(client, now)) lastOpen = now;
      expect(now - lastOpen).toBeLessThan(10_000);
    }
  } finally { setSystemTime(); }
});

it("a revoke ends the connection with 1008 and leaves its pending input to the socket's close", () => {
  const { client, clients, present, log, admit, revoke, end, mayType, authorizeSocket } = harness({ deviceId: "phone" });
  expect(admit(client)).toBe(true);
  expect(mayType(client)).toBe(true);
  revoke();
  expect(log).toEqual(["detach claimed", "drop claims", "closed 1008 Device access revoked"]);
  expect(clients.has(client) || present.has(client)).toBe(false);
  expect(mayType(client)).toBe(false);
  expect(() => authorizeSocket(client)).toThrow("this device's access was revoked");
  end(client, "closed");
  expect(log.slice(3)).toEqual(["unwatch device", "pending closed", "detach claimed", "drop claims"]);
});

it("does not admit a device that was revoked before its socket opened", () => {
  const { client, log, admit } = harness({ deviceId: "phone", revokedAlready: true });
  expect(admit(client)).toBe(false);
  expect(log.at(-1)).toBe("closed 1008 Device access revoked");
});

it("revoking every device ends local and relayed device connections alike, and admits none after", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-connections-revoke-all-"));
  try {
    const store = new DeviceStore(root);
    const phone = store.pair(store.startPairing().code, "Phone", "drive")!;
    store.match(phone.token);
    const tablet = store.pair(store.startPairing().code, "Tablet", "drive")!;
    store.match(tablet.token);
    const relayed: string[] = [];
    const relay = { close: () => relayed.push("relay closed") } as unknown as MachineRelay;
    const local = harness({ deviceId: phone.device.id, store });
    const remote = harness({ deviceId: tablet.device.id, relay, store });
    expect(local.admit(local.client)).toBe(true);
    expect(remote.admit(remote.client)).toBe(true);
    expect(store.revokeAll().sort()).toEqual([phone.device.id, tablet.device.id].sort());
    expect(local.log).toEqual(["detach claimed", "drop claims", "closed 1008 Device access revoked"]);
    expect(remote.log).toEqual(["detach claimed", "drop claims", "closed 1008 Device access revoked"]);
    // the relayed connection's relay is closed with the revocation itself, before its socket's own close
    expect(relayed).toEqual(["relay closed"]);
    expect(local.mayType(local.client)).toBe(false);
    expect(() => remote.authorizeSocket(remote.client)).toThrow("this device's access was revoked");
    remote.end(remote.client, "closed");
    expect(relayed).toEqual(["relay closed", "relay closed"]);
    // a socket that opens with a revoked device's cookie after the fact is closed at once
    const late = harness({ deviceId: phone.device.id, store });
    expect(late.admit(late.client)).toBe(false);
    expect(late.log.at(-1)).toBe("closed 1008 Device access revoked");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("closes only the relay of a relayed connection", () => {
  const relayed: string[] = [];
  const relay = { close: () => relayed.push("relay closed") } as unknown as MachineRelay;
  const { client, present, log, end } = harness({ relay });
  end(client, "closed");
  expect(relayed).toEqual(["relay closed"]);
  expect(log).toEqual([]);
  expect(present.has(client)).toBe(false);
});

it("counts each change of role, and a read-only connection only watches", () => {
  const { client, setRole, mayType } = harness();
  setRole(client, "interact");
  expect(connectionOf(client).roles).toBe(0);
  setRole(client, "observe");
  setRole(client, "interact");
  expect(connectionOf(client)).toMatchObject({ mode: "interact", roles: 2 });
  expect(mayType(client)).toBe(true);
  const watcher = harness({ readOnly: true });
  expect(connectionOf(watcher.client).mode).toBe("observe");
  expect(() => watcher.authorizeSocket(watcher.client)).toThrow("this connection can only watch");
});
