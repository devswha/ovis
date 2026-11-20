import { afterEach, beforeEach, expect, it, jest } from "bun:test";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import type { HoldState } from "../../../shared/account-devices-api.ts";
import { accountDeviceId } from "../../../shared/account-records.ts";
import { generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { encodeFrame, FrameType, MuxProtocolError, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayPcTable } from "../../components/RelayPcTable.tsx";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { beginSignIn } from "../account/signin.ts";
import { memoryAccountStore } from "../account/store.ts";
import { SettingsProvider } from "../settings.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import { dashboardModel, dashboardPcs } from "./dashboard.ts";
import { accountOpenPeer } from "./accountOpenPeer.ts";
import type { ShellDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";
import { mountRelayShell, type RelayShellMount } from "./shell.tsx";
import { openRelayTransport, RelayTransport } from "./transport.ts";

const SERVICE = "https://account.ovis.sh";
const APP = "https://app.ovis.sh";
const RELAY = "wss://relay.ovis.sh";
const store: ShellDeviceStore = {
  get: async () => undefined, list: async () => [], remove: async () => {},
  removeRow: async () => false, update: async (_id, change) => change(undefined),
};

let browser: ReturnType<typeof createShellTestPage>;
beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
afterEach(() => { jest.useRealTimers(); setTransport(nativeTransport); browser.dispose(); });

async function accountPc({ release = true, loseRegistrationReply = false, open }: {
  release?: boolean; loseRegistrationReply?: boolean;
  open: (...args: [...Parameters<NonNullable<RelayShellMount["open"]>>, ReturnType<typeof generateKeyPair>]) => Promise<RelayTransport>;
}) {
  const identity = generateKeyPair();
  const serverId = deriveServerId(identity.publicKey);
  const entry = { server_id: serverId, label: "Desk", public_key: Buffer.from(identity.publicKey).toString("hex"), relay: RELAY, added_at: new Date().toISOString(), last_seen_at: new Date().toISOString() };
  const accountStore = memoryAccountStore();
  const service = new FakeAccountService();
  service.signInAs("github", "acct_1");
  const started = await beginSignIn("github", { store: accountStore, service: SERVICE, redirectUri: WEB_REDIRECT });
  const returned = (await service.fetch(started)).headers.get("location");
  if (returned === null) throw new TypeError("Missing OAuth return");
  const requests: string[] = [];
  const registrationKeys: string[] = [];
  const navigations: string[] = [];
  let props: RelayShellProps | undefined;
  let apps = 0;
  const render = (node: ReactNode): void => {
    if (!isValidElement<{ readonly children?: ReactNode }>(node)) throw new TypeError("Missing shell");
    if (node.type === RelayShell && isValidElement<RelayShellProps>(node)) { props = node.props; return; }
    render(node.props.children);
  };
  const mountAt = (entryUrl: string) => mountRelayShell({
    container: Object.create(null), entryUrl, shellVersion: "1.0.0", store, accountStore,
    accountService: SERVICE, accountFetch: async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      requests.push(path);
      switch (path) {
        case "/v1/pcs": return Response.json({ pcs: [entry] });
        case "/v1/devices/challenge": return release
          ? Response.json({ challenge_id: "12".repeat(16), challenge: "register-this-sign-in" })
          : new Response(null, { status: 404 });
        case "/v1/devices": {
          const key = JSON.parse(String(init?.body)).key;
          registrationKeys.push(key);
          if (key !== registrationKeys[0]) return new Response(null, { status: 409 });
          if (loseRegistrationReply && registrationKeys.length === 1) throw new TypeError("Registration reply lost after commit");
          return Response.json({ no: 7, key });
        }
        default: return service.fetch(input, init);
      }
    },
    createRoot: () => ({ render, unmount() {} }),
    renderApp: () => { apps++; return { render() {}, unmount() {} }; },
    pendingPush: { get: async () => undefined, clear: async () => {} },
    checkPc: async () => ({ kind: "offline", reason: "relay" }),
    navigate: (path) => { navigations.push(path); },
    open: (offer, options) => open(offer, options, identity),
  });
  await mountAt(`${APP}/${new URL(returned).hash}`);
  const current = (): RelayShellProps => { if (props === undefined) throw new TypeError("Missing shell props"); return props; };
  const markup = (): string => {
    const { state, directoryRelays } = current();
    if (state.kind !== "empty" || state.account?.kind !== "signed-in" || state.account.pcs === null) throw new TypeError("Missing signed-in directory");
    const rows = dashboardModel(dashboardPcs(state.account.pcs, [], directoryRelays), { label: "Device" }, RELAY).rows;
    return renderToStaticMarkup(createElement(SettingsProvider, null, createElement(RelayPcTable, { rows, onSelect() {}, onOpenSheet() {} })));
  };
  return { accountStore, serverId, requests, registrationKeys, navigations, current, markup, apps: () => apps, reload: () => mountAt(`${APP}/`), openPage: () => mountAt(`${APP}/s/${serverId}/`) };
}

it("T34, P18: a normal sign-in opens a listed unpaired PC as its registered account row", async () => {
  const admissions: { feature: boolean | undefined; row: string | null | undefined; key: string | undefined }[] = [];
  class Admitted extends RelayTransport {
    override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
  }
  const run = await accountPc({ open: async (offer, options) => {
    const row = await options?.store?.get(offer.server_id);
    admissions.push({ feature: options?.accountOpensAll, row: row?.device_id, key: row?.public_spki });
    return new Admitted(offer);
  } });
  const key = await run.accountStore.get("signin_key");
  const markup = run.markup();
  await run.openPage();
  expect({
    number: key?.no, open: markup.includes('data-pc-action="open"'), join: markup.includes('data-pc-action="join"'),
    admissions, apps: run.apps(), navigations: run.navigations,
  }).toEqual({
    number: 7, open: true, join: false,
    admissions: key ? [{ feature: true, row: accountDeviceId(run.serverId, key.key.public_spki), key: key.key.public_spki }] : [],
    apps: 1, navigations: [],
  });
});

it("P18: an account service without the release only receives the challenge probe and still offers Join", async () => {
  const run = await accountPc({ release: false, open: () => { throw new TypeError("Join must wait for confirmation"); } });
  expect(run.markup()).toContain('data-pc-action="join"');
  expect(run.markup()).not.toContain('data-pc-action="open"');
  expect(run.requests.filter((path) => path.startsWith("/v1/devices"))).toEqual(["/v1/devices/challenge"]);
  expect(await run.accountStore.get("signin_key")).toBeUndefined();
  await run.openPage();
  expect(run.navigations).toEqual([expect.stringContaining(`/s/${run.serverId}/#`)]);
});

const refused = (code: string, hold?: HoldState) =>
  Object.assign(new MuxProtocolError("protocol_error", "PC refused"), { code, ...(hold === undefined ? {} : { hold }) });

it("P18, T34: reloading after a lost registration reply opens the PC with the same sign-in key", async () => {
  const run = await accountPc({ loseRegistrationReply: true, open: async (offer) => new class extends RelayTransport {
    override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
  }(offer) });
  const pending = await run.accountStore.get("signin_key");
  expect(pending?.no).toBeNull();
  await run.reload();
  expect(run.markup()).toContain('data-pc-action="open"');
  await run.openPage();
  expect(run.apps()).toBe(1);
  expect(run.registrationKeys).toEqual([pending?.key.public_spki, pending?.key.public_spki]);
});

it.each([false, true])("G5: an old PC (provisional WELCOME: %s) gets no account AUTH and offers pairing", async (provisional) => {
  let auths = 0;
  const run = await accountPc({ open: (offer, options, identity) => openRelayTransport(offer, {
    ...options, socket: () => accountOpenPeer(identity, { features: [], provisional, auth: () => {
      auths++;
      return encodeFrame({ type: FrameType.SESSION_ERROR, stream_id: 0, flags: 0, payload: { code: "auth_failed", message: "" } });
    } }),
  }) });
  await run.openPage();
  expect({ auths, navigation: run.navigations, state: run.current().state.kind }).toEqual({
    auths: 0, navigation: [expect.stringContaining(`/s/${run.serverId}/#offer=`)], state: "connecting",
  });
});

it.each([
  ["not_listed", [true, true]],
  ["admission", [true]],
] as const)("T34, G5: %s offers the same PC's pairing path after the allowed account attempts", async (code, expected) => {
  const attempts: (boolean | undefined)[] = [];
  const run = await accountPc({ open: async (_offer, options) => {
    attempts.push(options?.accountOpensAll);
    throw refused(code);
  } });
  await run.openPage();
  expect({ attempts, navigation: run.navigations, apps: run.apps() }).toEqual({
    attempts: [...expected], navigation: [expect.stringContaining(`/s/${run.serverId}/#offer=`)], apps: 0,
  });
});

it("T34: a join hold waits in Connecting and retries at the PC's deadline", async () => {
  const delay = 4_321;
  const expired = Promise.withResolvers<boolean | undefined>();
  let attempts = 0;
  let until = "";
  const run = await accountPc({ open: async (_offer, options) => {
    if (++attempts === 1) throw refused("held", { reason: "join_hold", until });
    expired.resolve(options?.accountOpensAll);
    throw refused("admission");
  } });
  jest.useFakeTimers();
  until = new Date(Date.now() + delay).toISOString();
  await run.openPage();
  expect(run.current().state.kind).toBe("connecting");
  jest.advanceTimersByTime(delay - 1);
  expect(attempts).toBe(1);
  jest.advanceTimersByTime(1);
  expect(await expired.promise).toBe(true);
});

it("P7: catching up without a deadline stays in Connecting and does not retry on a client deadline", async () => {
  let attempts = 0;
  const run = await accountPc({ open: async () => {
    attempts++;
    throw refused("held", { reason: "catching_up" });
  } });
  jest.useFakeTimers();
  await run.openPage();
  jest.advanceTimersByTime(60_000);
  expect({ kind: run.current().state.kind, attempts, navigations: run.navigations }).toEqual({ kind: "connecting", attempts: 1, navigations: [] });
});
