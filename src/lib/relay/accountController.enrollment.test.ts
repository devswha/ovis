import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { EnrollmentStatus } from "../../components/EnrollmentStatus.tsx";
import { RelayPcDetails } from "../../components/RelayPcDetails.tsx";
import { RelayPcTable } from "../../components/RelayPcTable.tsx";
import { ACCOUNT_FEATURE, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { accountDeviceId, newRecordId, signAccountRecord } from "../../../shared/account-records.ts";
import type { AddRecord } from "../../../shared/account-records.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import type { PcFetch } from "../account/join.ts";
import { enrollPc, planEnroll, rememberDevice } from "../account/join.ts";
import { memoryAccountStore } from "../account/store.ts";
import { AccountService } from "../account/service.ts";
import { myPcs } from "../account/myPcs.ts";
import { SettingsProvider } from "../settings.ts";
import { setCurrentLanguage, translate } from "../i18n.ts";
import { createAccountController } from "./accountController.ts";
import { enrollmentOf, type RelayDevice, type RelayDeviceStore } from "./device.ts";
import { dashboardModel, dashboardPcs } from "./dashboard.ts";
import { createShellTestPage } from "./shell.test.tsx";
import { RelayTransport } from "./transport.ts";
import { forgetSavedPc } from "./updateFlow.ts";

describe("account enrollment ownership", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  const transports: RelayTransport[] = [];
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
  afterEach(() => {
    for (const transport of transports.splice(0)) transport.close();
    browser.dispose();
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    else delete (globalThis as Record<string, unknown>)["navigator"];
    setCurrentLanguage("en");
  });

  async function fixture(heldPath: string, options: { readonly linking?: boolean; readonly admitted?: number; readonly listed?: boolean; readonly holdRenewal?: boolean; readonly peerFetch?: PcFetch } = {}) {
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
      update: async (id, change, source) => { source?.assert(devices.get(source.serverId)); const next = change(devices.get(id)); devices.set(id, next); return next; },
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
    class Peer extends RelayTransport {
      override async fetch(path: string, init?: RequestInit) {
        if (options.peerFetch === undefined) throw new TypeError("Unexpected peer request");
        return options.peerFetch(path, init);
      }
    }
    const open = async (target: RelayOffer = offer) => { const transport = target.server_id === offer.server_id ? new Admitted(offer) : new Peer(target); transports.push(transport); return transport; };
    const controller = () => createAccountController({
      container: Object.create(null), entryUrl: "https://app.ovis.invalid", renderApp: () => { throw new TypeError("No app here"); },
      store, accountStore, accountService: "https://account.invalid", accountProviders: ["github"], open,
      accountFetch: async (input, init) => {
        if (init?.method === "PUT") putPcs.push("put");
        if (options.listed && init?.method === "GET") return Response.json({ pcs: [{ server_id: "a".repeat(32), label: "Unread PC", public_key: null, relay: offer.relay, added_at: new Date().toISOString(), last_seen_at: null }] });
        return service.fetch(input, init);
      },
    }, { active: () => false, changed: async () => {}, outdated: () => new Set() });
    return { controller: controller(), otherController: controller(), store, original, requested, response, answer, open, records, putPcs, renewalRequested, renewalResponse, accountStore, key, service };
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

  it.each(["same", "other"] as const)("does not save an introduced pairing after the %s controller forgets its source during a held update", async (canceller) => {
    const run = await fixture("/api/account/introduction");
    const identity = generateKeyPair();
    const introduced = { server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: run.original.relay, name: "Introduced" };
    const updating = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const update = run.store.update;
    run.store.update = async (id, change, source) => {
      if (id === introduced.server_id) { updating.resolve(); await release.promise; }
      return update(id, change, source);
    };
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await run.requested.promise;
    run.response.resolve(Response.json({ pcs: [introduced] }));
    await updating.promise;
    const controller = canceller === "same" ? run.controller : run.otherController;
    controller.cancelEnrollment(run.original.server_id);
    await forgetSavedPc(run.original.server_id, run.store);
    release.resolve();
    await pending;
    expect(await run.store.get(introduced.server_id)).toBeUndefined();
  });

  it.each(["cancel", "forget", "forget-body"] as const)("stops multi-key peer introductions after source %s during the first request", async (action) => {
    const requested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const delivered: unknown[] = [];
    const run = await fixture("unused", { peerFetch: async (path, init) => {
      if (path === "/api/account/status?fresh=1") return Response.json({ account: "account", fresh: true, removals: [], adds: [], blocked: [] });
      if (path !== "/api/account/introduce") throw new TypeError("Unexpected peer request: " + path);
      delivered.push(JSON.parse(String(init?.body)));
      if (delivered.length === 1) {
        if (action === "forget-body") {
          class HeldRefusal extends Response {
            override async json() { requested.resolve(); return (await response.promise).json(); }
          }
          return new HeldRefusal(null, { status: 404 });
        }
        requested.resolve(); return response.promise;
      }
      return Response.json({});
    } });
    const identity = generateKeyPair();
    const peer = { ...run.original, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey) };
    await run.store.update(peer.server_id, () => peer);
    const firstRecord = run.records[0];
    if (firstRecord === undefined) throw new TypeError("Missing enrollment record");
    if (action === "forget-body") await run.accountStore.set("enrolls", { [run.original.server_id]: {
      account: "account", done: [], introduce: { keys: [firstRecord.key], pc: {
        server_id: run.original.server_id, server_public_key: run.original.server_public_key, relay: run.original.relay, name: "Desk",
      }, to: [peer.server_id] },
    } });
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await requested.promise;
    if (action === "cancel") run.controller.cancelEnrollment(run.original.server_id);
    else { run.otherController.cancelEnrollment(run.original.server_id); await forgetSavedPc(run.original.server_id, run.store); }
    response.resolve(Response.json(action === "forget-body" ? { error: { code: "introduction_unknown_key" } } : {}));
    expect(await pending).toBeInstanceOf(DOMException);
    expect(delivered).toEqual([{ key: run.records[0]?.key, pcs: [{ server_id: run.original.server_id, server_public_key: run.original.server_public_key, relay: run.original.relay, name: "Desk" }] }]);
    expect((await run.accountStore.get("enrolls"))?.[run.original.server_id]?.introduce?.to).toEqual([peer.server_id]);
  });

  it.each(["en", "ja", "ko", "zh"] as const)("keeps all enrollment surfaces truthful after listing succeeds and setup fails in %s", async (language) => {
    const run = await fixture("/api/account/enroll");
    const pending = run.controller.enroll(await run.open(), run.original.server_id, false).catch((error: unknown) => error);
    await run.requested.promise;
    run.response.resolve(Response.json({ error: { code: "account_unavailable" } }, { status: 503 }));
    await pending;
    const directory = await new AccountService({ store: run.accountStore, fetch: run.service.fetch }).listPcs();
    expect(directory.map((pc) => pc.server_id)).toEqual([run.original.server_id]);
    const devices = await run.store.list();
    const pc = devices[0];
    if (pc === undefined) throw new TypeError("Missing paired PC");
    const rows = dashboardModel(dashboardPcs(myPcs(directory, devices, { now: Date.now(), account: "account", accountKey: run.key.public_spki }), devices, directory), { label: "Phone" }, pc.relay).rows;
    const row = rows[0];
    if (row === undefined) throw new TypeError("Missing dashboard row");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: [language] } });
    const surfaces = [
      { element: createElement(RelayPcTable, { rows, onSelect() {}, onOpenSheet() {} }), text: "Account setup is incomplete. Open it to try again." },
      { element: createElement(RelayPcDetails, { pc: row, onClose() {} }), text: "Account setup is incomplete." },
      { element: createElement(EnrollmentStatus, { state: enrollmentOf(pc) }), text: "Account setup is incomplete." },
    ];
    for (const surface of surfaces) {
      const markup = renderToStaticMarkup(createElement(SettingsProvider, { children: surface.element }));
      expect(markup).toContain(translate(language, surface.text));
      expect(markup).not.toContain(translate(language, "Ready · not in the account yet"));
    }
  });

  it("retains confirmed admissions when an introduction-only retry adds none", async () => {
    const run = await fixture("unused");
    const introducing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    let introductions = 0;
    let enrollments = 0;
    const options = {
      store: run.accountStore, account: "account", serverId: run.original.server_id,
      pc: { ...run.original, name: "Desk" },
      fetch: async (path: string) => { enrollments++; return run.answer(path); },
      others: [{ serverId: "peer", fetch: async (path: string) => {
        switch (path) {
          case "/api/account/status?fresh=1": return Response.json({ account: "account", fresh: true, removals: [], adds: [], blocked: [] });
          case "/api/account/introduce":
            if (++introductions === 1) { introducing.resolve(); return release.promise; }
            return Response.json({});
          default: throw new TypeError("Unexpected peer request: " + path);
        }
      } }],
    };
    const first = enrollPc(options);
    await introducing.promise;
    release.resolve(Response.json({ error: { code: "unavailable" } }, { status: 503 }));
    expect(await first).toMatchObject({ finished: false, admitted: run.records.map((record) => record.key) });
    const admittedBeforeRetry = enrollments;
    const again = await enrollPc(options);
    expect(again.finished).toBe(true);
    expect(enrollments).toBe(admittedBeforeRetry);
    expect(again.admitted).toEqual(run.records.map((record) => record.key));
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
