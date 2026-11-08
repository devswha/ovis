import { afterEach, expect, it } from "bun:test";
import { RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { RelayTransport } from "./transport.ts";
import { createUpdateFlow, observedVersions } from "./updateFlow.ts";
import type { Attempt, RelayShellState } from "./shellState.ts";
import { nativeTransport, setTransport } from "../transport.ts";

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
afterEach(() => {
  if (descriptor) Object.defineProperty(globalThis, "sessionStorage", descriptor);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
  setTransport(nativeTransport);
});

it("keeps admitted old-version metadata across controllers and clears it on a newer admission", async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: "unused", relay: "wss://relay.ovis.sh" };
  class Admitted extends RelayTransport {
    version = "0.0.1";
    override get server() { return { version: this.version, relayProtocol: RELAY_PROTOCOL }; }
    override async fetch() { return Response.json({ managed: false }); }
  }
  const opened = new Admitted(offer);
  const states: RelayShellState[] = [];
  const flow = createUpdateFlow("1.0.0", {
    show: (state) => states.push(state), accepted() {}, reload: async () => {},
    failed: async (error) => { throw error; },
  });
  const attempt: Attempt = { offer, code: false, paired: true };
  try {
    await flow.admit(opened, attempt);
    expect(observedVersions().get(offer.server_id)).toEqual({ version: "0.0.1", outdated: true });
    expect(states.at(-1)).toMatchObject({ kind: "outdated", update: { phase: "manual" } });
    opened.version = "1.0.0";
    await flow.admit(opened, attempt);
    expect(observedVersions().get(offer.server_id)).toEqual({ version: "1.0.0", outdated: false });
    expect([...values.values()].join()).not.toContain("server_public_key");
  } finally { flow.cancel(); opened.close(); }
});

it("never installs after cancellation while an update-status read was pending", async () => {
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: "unused", relay: "wss://relay.ovis.sh" };
  const held = Promise.withResolvers<Response>();
  const reading = Promise.withResolvers<void>();
  let reads = 0;
  const writes: string[] = [];
  class Admitted extends RelayTransport {
    override get server() { return { version: "0.0.1", relayProtocol: RELAY_PROTOCOL }; }
    override async fetch(input: RequestInfo | URL, init?: RequestInit) {
      if (init?.method === "POST") { writes.push(String(input)); return Response.json({}); }
      if (++reads === 1) return Response.json({ managed: true });
      reading.resolve();
      return held.promise;
    }
  }
  const opened = new Admitted(offer);
  const states: RelayShellState[] = [];
  const flow = createUpdateFlow("1.0.0", { show: (state) => states.push(state), accepted() {}, reload: async () => {}, failed: async (error) => { throw error; } });
  try {
    await flow.admit(opened, { offer, paired: true, code: false });
    flow.update();
    await reading.promise;
    flow.cancel();
    const count = states.length;
    held.resolve(Response.json({ managed: true, available: true, latest_revision: "new" }));
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(writes).toEqual([]);
    expect(states).toHaveLength(count);
  } finally { flow.cancel(); opened.close(); }
});
