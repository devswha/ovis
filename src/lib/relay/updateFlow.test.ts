import { afterEach, expect, it } from "bun:test";
import { MuxProtocolError, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { RelayTransport } from "./transport.ts";
import { createUpdateFlow, observedVersions } from "./updateFlow.ts";
import type { Attempt, RelayShellState } from "./shellState.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import { isValidElement, type ReactNode } from "react";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { createShellTestPage } from "./shell.test.tsx";
import { forgetSavedPc, mountRelayShell, type RelayShellMount } from "./shell.tsx";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import type { RelayDevice } from "./device.ts";

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

/** Captures the actual controller/view boundary; transports below supply only PC responses. */
function shellFixture() {
  const browser = createShellTestPage();
  const devices = new Map<string, RelayDevice>();
  const pair = generateKeyPair();
  const offer = { v: 1 as const, server_id: deriveServerId(pair.publicKey), server_public_key: exportPublicKey(pair.publicKey), relay: "wss://relay.ovis.sh" };
  let shown: RelayShellProps | undefined;
  let apps = 0;
  const mount: RelayShellMount = {
    container: document.documentElement, entryUrl: encodeOffer(offer, "https://app.ovis.sh"), shellVersion: "1.0.0", label: "Phone",
    accountService: null, pendingPush: { get: async () => undefined, clear: async () => {} },
    store: {
      get: async (id) => devices.get(id), list: async () => [...devices.values()],
      remove: async (id) => { devices.delete(id); },
      update: async (id, change) => { const next = change(devices.get(id)); devices.set(id, next); return next; },
    },
    renderApp: () => { apps++; return { render() {}, unmount() {} }; },
    createRoot: () => ({ render(node: ReactNode) {
      let element = node;
      while (isValidElement<{ children: ReactNode }>(element) && element.type !== RelayShell) element = element.props.children;
      if (!isValidElement<RelayShellProps>(element) || element.type !== RelayShell) throw new Error("Expected the relay shell view");
      shown = element.props;
    }, unmount() {} }),
  };
  return { browser, offer, mount, devices, apps: () => apps, view: () => {
    if (shown === undefined) throw new Error("The shell has not rendered");
    return shown;
  } };
}

it.each(["retry", "disconnect"] as const)("keeps Ready pending through %s after a fresh outdated admission until Open PC", async (recovery) => {
  const fixture = shellFixture();
  class Admitted extends RelayTransport {
    version = "0.0.1";
    override get server() { return { version: this.version, relayProtocol: RELAY_PROTOCOL }; }
    override async fetch() { return Response.json({ managed: false }); }
  }
  const first = new Admitted(fixture.offer), next = new Admitted(fixture.offer);
  next.version = "1.0.0";
  let attempts = 0;
  let fatal: ((error: Error) => void) | undefined;
  try {
    await mountRelayShell({ ...fixture.mount, open: async (_offer, options) => { fatal = options?.onFatal; return ++attempts === 1 ? first : next; } });
    fixture.view().onPair();
    for (let i = 0; i < 500; i++) await Promise.resolve();
    expect(fixture.view().state).toMatchObject({ kind: "outdated", update: { phase: "manual" } });
    if (recovery === "disconnect") fatal?.(new MuxProtocolError("timeout", "fixture disconnected"));
    fixture.view().onRetry();
    for (let i = 0; i < 500; i++) await Promise.resolve();
    expect(fixture.apps()).toBe(0);
    expect(fixture.view().state.kind).toBe("ready");
    fixture.view().onOpenPc?.();
    expect(fixture.apps()).toBe(1);
    fatal?.(new MuxProtocolError("timeout", "fixture disconnected"));
    fixture.view().onRetry();
    for (let i = 0; i < 500; i++) await Promise.resolve();
    expect(fixture.apps()).toBe(2);
  } finally { first.close(); next.close(); fixture.browser.dispose(); }
});

it.each(["settings", "shell"] as const)("clears only the forgotten PC's admitted version through %s", async (path) => {
  const fixture = shellFixture();
  const otherId = "ab".repeat(16);
  class Outdated extends RelayTransport {
    override get server() { return { version: "0.0.1", relayProtocol: RELAY_PROTOCOL }; }
    override async fetch() { return Response.json({ managed: false }); }
  }
  const opened = new Outdated(fixture.offer);
  try {
    fixture.browser.sessionStore.set("ovis-relay-versions", JSON.stringify([[otherId, { version: "0.0.2", outdated: true }]]));
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    fixture.devices.set(fixture.offer.server_id, { ...fixture.offer, device_id: "paired", private_key: key.privateKey, public_spki: "fixture", label: "Phone" });
    await mountRelayShell({ ...fixture.mount, entryUrl: `https://app.ovis.sh/s/${fixture.offer.server_id}/`, open: async () => opened });
    expect(observedVersions().has(fixture.offer.server_id)).toBe(true);
    switch (path) {
      case "settings": await forgetSavedPc(fixture.offer.server_id, fixture.mount.store); break;
      case "shell":
        fixture.view().onForget();
        for (let i = 0; i < 500; i++) await Promise.resolve();
        expect(fixture.view().state.kind).toBe("forgotten");
        break;
    }
    expect(fixture.devices.has(fixture.offer.server_id)).toBe(false);
    expect(observedVersions().has(fixture.offer.server_id)).toBe(false);
    expect(observedVersions().get(otherId)).toEqual({ version: "0.0.2", outdated: true });
  } finally { opened.close(); fixture.browser.dispose(); }
});
