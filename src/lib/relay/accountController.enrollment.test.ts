import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ACCOUNT_FEATURE, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { accountDeviceId, newRecordId, signAccountRecord } from "../../../shared/account-records.ts";
import type { AddRecord } from "../../../shared/account-records.ts";
import { planEnroll, rememberDevice } from "../account/join.ts";
import { memoryAccountStore } from "../account/store.ts";
import { createAccountController } from "./accountController.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";
import { RelayTransport } from "./transport.ts";
import { forgetSavedPc } from "./updateFlow.ts";

describe("account enrollment ownership", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  const transports: RelayTransport[] = [];
  beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
  afterEach(() => { for (const transport of transports.splice(0)) transport.close(); browser.dispose(); });

  async function fixture(heldPath: string, options: { readonly linking?: boolean; readonly admitted?: number; readonly listed?: boolean; readonly holdRenewal?: boolean } = {}) {
    const identity = generateKeyPair();
    const offer = { v: 1 as const, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.invalid", name: "Desk" };
    const accountStore = memoryAccountStore();
    const service = new FakeAccountService();
    await accountStore.set("session", { service: "https://account.invalid", account: "account", provider: "github", access_token: service.issueToken("account"), refresh_token: "test", expires_at: Date.now() + 3_600_000 });
    const key = await accountStore.key();
    const original: RelayDevice = { ...offer, device_id: "12".repeat(8), private_key: key.private_key, public_spki: key.public_spki, label: "Phone", account: "account" };
    const devices = new Map([[offer.server_id, original]]);
    const store: RelayDeviceStore = {
      get: async (id) => devices.get(id), list: async () => [...devices.values()], remove: async (id) => { devices.delete(id); },
      update: async (id, change) => { const next = change(devices.get(id)); devices.set(id, next); return next; },
    };
    const records: AddRecord[] = [];
    for (let index = 0; index < 2; index++) {
      const peerKey = await memoryAccountStore().key();
      const record = await signAccountRecord({ v: 1, kind: "add", account: "account", key: peerKey.public_spki, label: "Other device", role: "drive", issued_at: new Date().toISOString(), id: newRecordId(), signer: key.public_spki }, key.private_key);
      await rememberDevice(accountStore, record);
      records.push(record);
    }
    await planEnroll(accountStore, offer.server_id, "account");
    const requested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const renewalRequested = Promise.withResolvers<void>();
    const renewalResponse = Promise.withResolvers<void>();
    const putPcs: string[] = [];
    let linked = !options.linking;
    const answer = (path: string): Response => {
      switch (path) {
        case "/api/account/status": return Response.json({ account: linked ? "account" : null, unlinked: [], removals: [], enrolling: true });
        case "/api/account/link": linked = true; return Response.json({});
        case "/api/account/enroll": return Response.json({ results: records.map((record, index) => ({ id: record.id, outcome: index < (options.admitted ?? 2) ? "applied" : "refused", code: "key_held" })) });
        case "/api/account/introduction": return Response.json({ pcs: [] });
        default: throw new TypeError("Unexpected PC request: " + path);
      }
    };
    class Admitted extends RelayTransport {
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL, features: [ACCOUNT_FEATURE] }; }
      override async renew() {
        if (!options.holdRenewal) return;
        renewalRequested.resolve();
        await renewalResponse.promise;
      }
      override async fetch(path: string) { if (path === heldPath) { requested.resolve(); return response.promise; } return answer(path); }
    }
    const open = async () => { const transport = new Admitted(offer); transports.push(transport); return transport; };
    const controller = createAccountController({
      container: Object.create(null), entryUrl: "https://app.ovis.invalid", renderApp: () => { throw new TypeError("No app here"); },
      store, accountStore, accountService: "https://account.invalid", accountProviders: ["github"], open,
      accountFetch: async (input, init) => {
        if (init?.method === "PUT") putPcs.push("put");
        if (options.listed && init?.method === "GET") return Response.json({ pcs: [{ server_id: "a".repeat(32), label: "Unread PC", public_key: null, relay: offer.relay, added_at: new Date().toISOString(), last_seen_at: null }] });
        return service.fetch(input, init);
      },
    }, { active: () => false, changed: async () => {}, outdated: () => new Set() });
    return { controller, store, original, requested, response, answer, open, records, putPcs, renewalRequested, renewalResponse, accountStore, key, service };
  }

  it("does not list a pairing after Forget releases a held renewal", async () => {
    const run = await fixture("unused", { linking: true, holdRenewal: true });
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await run.renewalRequested.promise;
    await forgetSavedPc(run.original.server_id, run.store);
    run.renewalResponse.resolve();
    await pending;
    expect(run.putPcs).toEqual([]);
  });

  it("does not save an introduced pairing after Forget releases its held update", async () => {
    const run = await fixture("/api/account/introduction");
    const identity = generateKeyPair();
    const introduced = { server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: run.original.relay, name: "Introduced" };
    const updating = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const update = run.store.update;
    run.store.update = async (id, change) => {
      if (id === introduced.server_id) { updating.resolve(); await release.promise; }
      return update(id, change);
    };
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await run.requested.promise;
    run.response.resolve(Response.json({ pcs: [introduced] }));
    await updating.promise;
    run.controller.cancelEnrollment(run.original.server_id);
    await forgetSavedPc(run.original.server_id, run.store);
    release.resolve();
    await pending;
    expect(await run.store.get(introduced.server_id)).toBeUndefined();
  });


  it.each([
    ["/api/account/status", false], ["/api/account/link", true], ["/api/account/enroll", false], ["/api/account/introduction", false],
  ] as const)("does not restore a forgotten pairing after %s returns", async (path, linking) => {
    const run = await fixture(path, { linking });
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await run.requested.promise;
    await forgetSavedPc(run.original.server_id, run.store);
    run.response.resolve(run.answer(path));
    await pending;
    expect(await run.store.get(run.original.server_id)).toBeUndefined();
    expect((await run.store.list()).map((device) => device.private_key)).toEqual([]);
  });

  it.each([false, true])("does not recreate or alter a forgotten pairing after failure (replacement: %s)", async (replace) => {
    const run = await fixture("/api/account/enroll");
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await run.requested.promise;
    await forgetSavedPc(run.original.server_id, run.store);
    const key = await memoryAccountStore().key();
    const replacement = { ...run.original, device_id: accountDeviceId(run.original.server_id, key.public_spki), ...key };
    if (replace) await run.store.update(run.original.server_id, () => replacement);
    run.response.resolve(Response.json({ error: { code: "account_unavailable" } }, { status: 503 }));
    await pending;
    expect(await run.store.list()).toEqual(replace ? [replacement] : []);
  });

  it.each([0, 1, 2])("reports the actual %s admitted devices instead of universal access", async (admitted) => {
    const run = await fixture("unused", { admitted });
    const outcome = await run.controller.enroll(await run.open(), run.original.server_id, false);
    expect(outcome).toEqual({ state: "complete", admitted });
  });

  it("reports no admitted devices when directory peers cannot be read", async () => {
    const run = await fixture("unused", { listed: true });
    expect(await run.controller.enroll(await run.open(), run.original.server_id, false)).toEqual({ state: "complete", admitted: 0 });
  });
});
