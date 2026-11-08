import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { ACCOUNT_FEATURE, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { addPcPhase } from "../../components/AddPcSheet.tsx";
import { relayFailureText } from "../../components/relayFailureText.ts";
import { t } from "../i18n.ts";
import { memoryAccountStore } from "../account/store.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import { mountRelayShell } from "./shell.tsx";
import { createShellTestPage } from "./shell.test.tsx";
import { RelayTransport } from "./transport.ts";

async function until(holds: () => boolean): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) { if (holds()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  throw new Error("Enrollment did not reach the expected state");
}

describe("account pairing completion", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  const transports: RelayTransport[] = [];
  beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
  afterEach(() => { for (const transport of transports.splice(0)) transport.close(); setTransport(nativeTransport); browser.dispose(); });

  async function pairing() {
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
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL, features: [ACCOUNT_FEATURE] }; }
      override async renew() {}
      override async fetch(path: string) {
        switch (path) {
          case "/api/account/status": return Response.json({ account: linked ? "acct-test" : null, unlinked: [], removals: [], enrolling: true });
          case "/api/account/link": linked = true; return Response.json({});
          case "/api/account/enroll": requested = true; return response;
          case "/api/account/introduction": return Response.json({ pcs: [{ ...offer, server_id: deriveServerId(other.publicKey), server_public_key: exportPublicKey(other.publicKey) }] });
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
      pendingPush: { get: async () => undefined, clear: async () => {} }, navigate() {},
      open: async () => { const opened = new Admitted(offer); transports.push(opened); return opened; },
    });
    current().onPair();
    await until(() => requested || current().state.kind === "ready");
    return { current, enrollment, apps: () => apps, retrySuccess: () => { response = Promise.resolve(Response.json({ results: [] })); } };
  }

  it("waits for account enrollment before Ready and opens only on request", async () => {
    const run = await pairing();
    expect(run.current().state.kind).toBe("connecting");
    run.current().onOpenPc?.();
    expect(run.apps()).toBe(0);
    run.enrollment.resolve(Response.json({ results: [] }));
    await until(() => run.current().state.kind === "ready");
    run.current().onOpenPc?.();
    expect(run.apps()).toBe(1);
  });

  it("shows filtered failure and retries enrollment without Ready on rejection", async () => {
    const run = await pairing();
    run.enrollment.resolve(Response.json({ error: { code: "account_unavailable", message: "private enrollment diagnostic" } }, { status: 503 }));
    await until(() => run.current().state.kind === "failed" || run.current().state.kind === "ready");
    const state = run.current().state;
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") throw new TypeError("Expected enrollment failure");
    expect(state.detail).toBeNull();
    expect(relayFailureText(t, state.failure, "Desk", state.detail).retry).toBe(true);
    expect(addPcPhase({ server_id: state.server_id ?? "", name: "Desk", state: "needs-approval", last_seen_at: null, added_at: null, listed: true, paired: false, linked: false }, state)).toBe("failed");
    expect(JSON.stringify(state)).not.toContain("private enrollment diagnostic");
    run.retrySuccess();
    run.current().onRetry();
    await until(() => run.current().state.kind === "ready");
    expect(run.apps()).toBe(0);
  });

  it("does not restore Ready after cancellation during enrollment", async () => {
    const run = await pairing();
    expect(run.current().state.kind).toBe("connecting");
    run.current().onCancel();
    const before = run.current();
    run.enrollment.resolve(Response.json({ results: [] }));
    for (let turn = 0; turn < 1000; turn++) await Promise.resolve();
    expect(run.current()).toBe(before);
    expect(run.apps()).toBe(0);
  });
});
