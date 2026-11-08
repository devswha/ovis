import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { ACCOUNT_FEATURE, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { myPcs } from "../account/myPcs.ts";
import { memoryAccountStore } from "../account/store.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import { mountRelayShell } from "./shell.tsx";
import { createShellTestPage } from "./shell.test.tsx";
import { RelayTransport } from "./transport.ts";

async function until(holds: () => boolean | Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) { if (await holds()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  throw new Error("Enrollment did not reach the expected state");
}

describe("account pairing completion", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  const transports: RelayTransport[] = [];
  beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
  afterEach(() => { for (const transport of transports.splice(0)) transport.close(); setTransport(nativeTransport); browser.dispose(); });

  async function pairing(introduction?: () => Response) {
    const identity = generateKeyPair();
    const offer = { v: 1 as const, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.ovis.sh", name: "Desk" };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: "https://account.ovis.sh", account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    const key = await accountStore.key();
    const devices = new Map<string, RelayDevice>([[offer.server_id, { ...offer, device_id: "12".repeat(8), private_key: key.private_key, public_spki: key.public_spki, label: "Phone" }]]);
    const store: RelayDeviceStore = {
      get: async (id) => devices.get(id), list: async () => [...devices.values()], remove: async (id) => { devices.delete(id); },
      update: async (id, change) => { const device = change(devices.get(id)); devices.set(id, device); return device; },
    };
    const enrollment = Promise.withResolvers<Response>();
    let requested = false, linked = false, apps = 0;
    let response = enrollment.promise;
    class Admitted extends RelayTransport {
      closed = false;
      override close() { this.closed = true; super.close(); }
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL, features: [ACCOUNT_FEATURE] }; }
      override async renew() {}
      override async fetch(path: string) {
        if (this.closed) throw new TypeError("Enrollment connection was closed");
        switch (path) {
          case "/api/account/status": return Response.json({ account: linked ? "acct-test" : null, unlinked: [], removals: [], enrolling: true });
          case "/api/account/link": linked = true; return Response.json({});
          case "/api/account/enroll": requested = true; return response;
          case "/api/account/introduction": return introduction?.() ?? Response.json({ pcs: [{ ...offer, server_id: deriveServerId(other.publicKey), server_public_key: exportPublicKey(other.publicKey) }] });
          default: throw new TypeError(`Unexpected PC request: ${path}`);
        }
      }
    }
    const other = generateKeyPair();
    let props: RelayShellProps | undefined;
    const render = (node: ReactNode): void => {
      if (!isValidElement<{ readonly children?: ReactNode }>(node)) throw new TypeError("Missing shell element");
      if (node.type === RelayShell && isValidElement<RelayShellProps>(node)) { props = node.props; return; }
      render(node.props.children);
    };
    const current = (): RelayShellProps => { if (!props) throw new TypeError("Shell not rendered"); return props; };
    browser.sessionStore.set("ovis-add-pc-sheet", JSON.stringify({ mode: "new", server_id: offer.server_id }));
    await mountRelayShell({
      container: Object.create(null), entryUrl: encodeOffer(offer, "https://app.ovis.sh"), shellVersion: "1.0.0", store, accountStore,
      accountService: "https://account.ovis.sh", accountFetch: async () => Response.json({ pcs: [] }),
      createRoot: () => ({ render, unmount() {} }), renderApp: () => { apps++; return { render() {}, unmount() {} }; },
      pendingPush: { get: async () => undefined, clear: async () => {} }, navigate() {}, checkPc: async () => ({ kind: "offline", reason: "relay" }),
      open: async () => { const opened = new Admitted(offer); transports.push(opened); return opened; },
    });
    current().onPair();
    await until(() => requested);
    const rows = async () => myPcs([], await store.list(), { now: Date.now(), accountKey: key.public_spki, account: "acct-test" });
    return { current, enrollment, rows, apps: () => apps, retrySuccess: () => { response = Promise.resolve(Response.json({ results: [] })); } };
  }

  it("shows Ready and opens the PC while account enrollment is pending", async () => {
    const run = await pairing();
    const pending = run.current().state;
    run.current().onOpenPc?.();
    run.enrollment.resolve(Response.json({ results: [] }));
    expect(pending).toMatchObject({ kind: "ready", enrollment: "pending" });
    expect(run.apps()).toBe(1);
    await until(async () => (await run.rows())[0]?.enrollment === "complete");
  });

  it("reports account completion only after enrollment resolves", async () => {
    const run = await pairing();
    run.enrollment.resolve(Response.json({ results: [] }));
    await until(() => { const state = run.current().state; return state.kind === "ready" && typeof state.enrollment === "object" && state.enrollment.state === "complete"; });
    expect(run.current().state).toMatchObject({ kind: "ready", enrollment: { state: "complete", admitted: 0 } });
    expect(run.apps()).toBe(0);
  });

  it("completes a successful enrollment when there are no peer PCs to introduce", async () => {
    const clock = spyOn(Date, "now");
    try {
      const run = await pairing(() => {
        clock.mockReturnValue(Date.now() + 60_001);
        return Response.json({ pcs: [] });
      });
      run.enrollment.resolve(Response.json({ results: [] }));
      await until(async () => (await run.rows())[0]?.enrollment !== "pending");
      expect(run.current().state).toMatchObject({ kind: "ready", enrollment: { state: "complete", admitted: 0 } });
    } finally { clock.mockRestore(); }
  });

  it.each(["rejection", "timeout"] as const)("keeps the local pairing Ready on %s and retries enrollment", async (failure) => {
    const run = await pairing();
    if (failure === "timeout") run.enrollment.reject(new DOMException("private enrollment diagnostic", "TimeoutError"));
    else run.enrollment.resolve(Response.json({ error: { code: "account_unavailable", message: "private enrollment diagnostic" } }, { status: 503 }));
    await until(() => { const state = run.current().state; return state.kind === "failed" || state.kind === "ready" && state.enrollment === "failed"; });
    const state = run.current().state;
    expect(state).toMatchObject({ kind: "ready", enrollment: "failed" });
    expect(JSON.stringify(state)).not.toContain("private enrollment diagnostic");
    run.retrySuccess();
    run.current().onRetry();
    await until(() => { const current = run.current().state; return current.kind === "ready" && typeof current.enrollment === "object" && current.enrollment.state === "complete"; });
    expect(run.apps()).toBe(0);
  });

  it.each(["open", "close"] as const)("reports a late failure on the dashboard row after %s", async (leave) => {
    const run = await pairing();
    if (leave === "open") run.current().onOpenPc?.(); else run.current().onCancel();
    run.enrollment.resolve(Response.json({ error: { code: "account_unavailable" } }, { status: 503 }));
    await until(async () => (await run.rows())[0]?.enrollment === "failed");
    expect((await run.rows())[0]).toMatchObject({ paired: true, linked: false, enrollment: "failed" });
    expect(run.apps()).toBe(leave === "open" ? 1 : 0);
    if (leave === "close") await until(() => run.current().state.kind === "list");
  });

  it("finishes enrollment after closing without reopening the checkpoint", async () => {
    const run = await pairing();
    run.current().onCancel();
    run.enrollment.resolve(Response.json({ results: [] }));
    await until(async () => (await run.rows())[0]?.enrollment === "complete");
    await until(() => run.current().state.kind === "list");
    expect(run.apps()).toBe(0);
  });
});
