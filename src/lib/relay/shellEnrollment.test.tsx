import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ACCOUNT_FEATURE, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { OpenPcEnrollmentNotice } from "../../components/EnrollmentNotice.tsx";
import { RelayPcTable } from "../../components/RelayPcTable.tsx";
import { ReadyCheckpoint, RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { myPcs } from "../account/myPcs.ts";
import { memoryAccountStore } from "../account/store.ts";
import { SettingsProvider } from "../settings.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import { dashboardModel, dashboardPcs } from "./dashboard.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import { showEnrollmentNotice } from "./enrollmentNotice.ts";
import { mountRelayShell } from "./shell.tsx";
import { createShellTestPage } from "./shellTestPage.fixture.ts";
import { RelayTransport } from "./transport.ts";

async function until(holds: () => boolean | Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) { if (await holds()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  throw new Error("Enrollment did not reach the expected state");
}

describe("account pairing completion", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  const transports: RelayTransport[] = [];
  beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => { jest.useRealTimers(); showEnrollmentNotice(null); for (const spy of spies.splice(0)) spy.mockRestore(); for (const transport of transports.splice(0)) transport.close(); setTransport(nativeTransport); browser.dispose(); });

  /**
   * `code`: a link with a pairing code, opened by navigation (no sheet). `outdatedFirst`: the PC answers once as a version too old, and Try again reaches it updated.
   * `peer`: another PC of the account this device is in, whose `read`th fresh status it answers (from 1): the enrollment reads it first.
   */
  async function pairing(introduction?: () => Response, options: { readonly code?: string; readonly outdatedFirst?: boolean; readonly peer?: (read: number) => Promise<Response> } = {}) {
    const identity = generateKeyPair();
    const offer = { v: 1 as const, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.ovis.sh", name: "Desk", ...(options.code === undefined ? {} : { code: options.code }) };
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: "https://account.ovis.sh", account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    const key = await accountStore.key();
    const devices = new Map<string, RelayDevice>([[offer.server_id, { ...offer, device_id: "12".repeat(8), private_key: key.private_key, public_spki: key.public_spki, label: "Phone" }]]);
    const peerIdentity = generateKeyPair();
    const peerId = deriveServerId(peerIdentity.publicKey);
    if (options.peer) devices.set(peerId, { ...offer, server_id: peerId, server_public_key: exportPublicKey(peerIdentity.publicKey), name: "Studio", device_id: "34".repeat(8), private_key: key.private_key, public_spki: key.public_spki, label: "Phone", account: "acct-test" });
    let peerReads = 0;
    /** told of every change the page or the PCs see: a render, a saved PC, a read of the other PC */
    const changes = new EventTarget();
    const changed = (): void => { changes.dispatchEvent(new Event("change")); };
    class Peer extends RelayTransport {
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL, features: [ACCOUNT_FEATURE] }; }
      override async renew() {}
      override async fetch(path: string) {
        if (path !== "/api/account/status?fresh=1" || !options.peer) throw new TypeError(`Unexpected peer request: ${path}`);
        peerReads++;
        changed();
        return options.peer(peerReads);
      }
    }
    const store: RelayDeviceStore = {
      get: async (id) => devices.get(id), list: async () => [...devices.values()], remove: async (id) => { devices.delete(id); },
      update: async (id, change) => { const device = change(devices.get(id)); devices.set(id, device); changed(); return device; },
    };
    const enrollment = Promise.withResolvers<Response>();
    let enrolls = 0, linked = false, apps = 0, opens = 0;
    let response = enrollment.promise;
    class Admitted extends RelayTransport {
      closed = false;
      override close() { this.closed = true; super.close(); }
      readonly version = options.outdatedFirst && opens++ === 0 ? "0.1.0" : "1.0.0";
      override get server() { return { version: this.version, relayProtocol: RELAY_PROTOCOL, features: [ACCOUNT_FEATURE] }; }
      override async renew() {}
      override async fetch(path: string) {
        if (this.closed) throw new TypeError("Enrollment connection was closed");
        switch (path) {
          case "/api/account/status": return Response.json({ account: linked ? "acct-test" : null, unlinked: [], removals: [], enrolling: true });
          case "/api/account/link": linked = true; return Response.json({});
          case "/api/account/enroll": enrolls++; return response;
          case "/api/account/introduction": return introduction?.() ?? Response.json({ pcs: [{ ...offer, server_id: deriveServerId(other.publicKey), server_public_key: exportPublicKey(other.publicKey) }] });
          default: throw new TypeError(`Unexpected PC request: ${path}`);
        }
      }
    }
    const other = generateKeyPair();
    let props: RelayShellProps | undefined;
    const kinds: string[] = [];
    const render = (node: ReactNode): void => {
      if (!isValidElement<{ readonly children?: ReactNode }>(node)) throw new TypeError("Missing shell element");
      if (node.type === RelayShell && isValidElement<RelayShellProps>(node)) { props = node.props; kinds.push(node.props.state.kind); changed(); return; }
      render(node.props.children);
    };
    const current = (): RelayShellProps => { if (!props) throw new TypeError("Shell not rendered"); return props; };
    if (options.code === undefined) browser.sessionStore.set("ovis-add-pc-sheet", JSON.stringify({ mode: "new", server_id: offer.server_id }));
    const mountAt = (entryUrl: string) => mountRelayShell({
      container: Object.create(null), entryUrl, shellVersion: "1.0.0", store, accountStore,
      accountService: "https://account.ovis.sh", accountFetch: async () => Response.json({ pcs: [] }),
      createRoot: () => ({ render, unmount() {} }), renderApp: () => { apps++; return { render() {}, unmount() {} }; },
      pendingPush: { get: async () => undefined, clear: async () => {} }, navigate() {}, checkPc: async () => ({ kind: "offline", reason: "relay" }),
      open: async (opening: { readonly server_id: string }) => { const opened = opening.server_id === peerId ? new Peer(offer) : new Admitted(offer); transports.push(opened); return opened; },
    });
    await mountAt(encodeOffer(offer, "https://app.ovis.sh"));
    await until(() => { const state = current().state; return state.kind === "confirm" && state.account !== "checking"; });
    current().onPair();
    if (options.outdatedFirst) {
      await until(() => { const state = current().state; return state.kind === "outdated" && state.update.phase === "manual"; });
      current().onRetry();
    }
    await until(() => enrolls > 0 || peerReads > 0);
    const rows = async () => myPcs([], await store.list(), { now: Date.now(), accountKey: key.public_spki, account: "acct-test" });
    const dashboard = async () => dashboardPcs(await rows(), await store.list());
    const pcPage = `https://app.ovis.sh/s/${offer.server_id}/`;
    const saved = (): unknown => { const device: object | undefined = devices.get(offer.server_id); return device && "account_enrollment" in device ? device.account_enrollment : undefined; };
    /** Once `holds`, checked now and on each change from here on; past `ms` the test fails naming `what`. */
    const when = (holds: () => boolean, what: string, ms = 10_000): Promise<void> => new Promise<void>((resolve, reject) => {
      const check = (): void => { if (!holds()) return; clearTimeout(timer); changes.removeEventListener("change", check); resolve(); };
      const timer = setTimeout(() => { changes.removeEventListener("change", check); reject(new Error(`${what}: not within ${ms} ms`)); }, ms);
      changes.addEventListener("change", check);
      check();
    });
    return { current, enrollment, rows, dashboard, mountAt, pcPage, kinds, saved, when, devices: () => [...devices.values()], peerReads: () => peerReads, enrolls: () => enrolls, apps: () => apps, retrySuccess: () => { response = Promise.resolve(Response.json({ results: [] })); } };
  }

  it("enters the PC as soon as a sheet join is admitted, with no Ready screen, and finishes the account's part behind it", async () => {
    const run = await pairing();
    expect(run.apps()).toBe(1);
    expect(run.kinds).not.toContain("ready");
    expect((await run.rows())[0]?.enrollment).toBe("pending");
    run.enrollment.resolve(Response.json({ results: [] }));
    await until(async () => (await run.rows())[0]?.enrollment === "complete");
    expect(run.apps()).toBe(1);
    expect(run.kinds).not.toContain("ready");
  });

  it("opens a saved PC that is still joining the account without stopping at Ready", async () => {
    const run = await pairing();
    expect((await run.rows())[0]?.enrollment).toBe("pending");
    await run.mountAt(run.pcPage);
    await until(() => run.apps() === 2);
    expect(run.kinds).not.toContain("ready");
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
      expect((await run.rows())[0]?.enrollment).toBe("complete");
      expect(run.kinds).not.toContain("ready");
    } finally { clock.mockRestore(); }
  });

  it.each(["rejection", "timeout"] as const)("records a %s on the row behind the open PC, then stops the next open at Ready with Try again", async (failure) => {
    const run = await pairing();
    if (failure === "timeout") run.enrollment.reject(new DOMException("private enrollment diagnostic", "TimeoutError"));
    else run.enrollment.resolve(Response.json({ error: { code: "account_unavailable", message: "private enrollment diagnostic" } }, { status: 503 }));
    await until(async () => (await run.rows())[0]?.enrollment === "failed");
    expect((await run.rows())[0]).toMatchObject({ paired: true, linked: false, enrollment: "failed" });
    expect(run.apps()).toBe(1);
    expect(run.kinds).not.toContain("ready");
    // the next open of the PC's own page: the enrollment is tried again, and its failure stays on screen before the app
    await run.mountAt(run.pcPage);
    await until(() => { const state = run.current().state; return state.kind === "ready" && state.enrollment === "failed"; });
    const state = run.current().state;
    expect(JSON.stringify(state)).not.toContain("private enrollment diagnostic");
    expect(renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(ReadyCheckpoint, { open() {}, cancel() {}, retry() {}, ...(state.kind === "ready" ? { state } : {}) }) }))).toContain("Try again");
    expect(run.apps()).toBe(1);
    run.retrySuccess();
    run.current().onRetry();
    await until(() => { const current = run.current().state; return current.kind === "ready" && typeof current.enrollment === "object" && current.enrollment.state === "complete"; });
    expect(run.apps()).toBe(1);
    run.current().onOpenPc?.();
    expect(run.apps()).toBe(2);
  });

  // how the shell tells the account side whether an introduction can come: only a member's approval of a pairing made
  // without a code hands one over, so only that pairing is kept looking for it
  it.each([
    ["a sheet join without a code keeps looking for a minute", {}, 21],
    ["a link with a code looks once", { code: "123456" }, 1],
    ["a join without a code still keeps looking after the outdated PC's Try again", { outdatedFirst: true }, 21],
  ] as const)("looks for the introduction as the pairing was made: %s", async (_what, options, reads) => {
    let introductions = 0;
    const run = await pairing(() => { introductions++; return Response.json({ pcs: [] }); }, options);
    jest.useFakeTimers();
    run.enrollment.resolve(Response.json({ results: [] }));
    // the enrollment signs and reads between its waits, which no faked clock runs: each turn lets that work land
    for (let turn = 0; (await run.rows())[0]?.enrollment === "pending" && turn < 5_000; turn++) {
      if (introductions > 0 && jest.getTimerCount() > 0) jest.advanceTimersByTime(3_000);
      await crypto.subtle.digest("SHA-256", new Uint8Array(1));
    }
    expect((await run.rows())[0]?.enrollment).toBe("complete");
    expect(introductions).toBe(reads);
    expect(run.apps()).toBe(1);
  });

  /** Another PC of the account, as it answers a fresh status: read whole, or its pull limited by the account service for 42 seconds. */
  const peerStatus = (limited: boolean) => Response.json({
    account: "acct-test", unlinked: [], removals: [], adds: [], blocked: [], enrolling: false, fresh: !limited,
    mailbox: { last_pull_at: null, error: limited ? "The account service answered 429 to /v1/pc/challenge" : null, ...(limited ? { refused: { status: 429, retry_after_s: 42 } } : {}) },
  });
  /** The enrollment's wait of 42 s for the account service: caught when it is set, and run when the test says; every other timer runs as it would. */
  function enrollmentWait(): Promise<() => void> {
    const real = globalThis.setTimeout;
    const asked = Promise.withResolvers<() => void>();
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
      if (ms !== 42_000 || typeof handler !== "function") return real(handler, ms, ...rest);
      asked.resolve(() => { handler(...rest); });
      const unused = real(() => undefined, 0);
      clearTimeout(unused);
      return unused;
    }) as typeof setTimeout);
    spies.push(spy);
    // bounded: a wait never asked for fails the test
    return Promise.race([asked.promise, new Promise<never>((_resolve, reject) => { real(() => reject(new Error("the enrollment never waited 42 s")), 10_000); })]);
  }
  const markup = (node: ReactNode): string => renderToStaticMarkup(createElement(SettingsProvider, { children: node }));

  it.each([
    ["the other PC reads whole", false, "complete"],
    ["the other PC is refused again", true, "failed"],
  ] as const)("says inside the PC just opened by a first pairing how long the account service asked to wait, and takes it away once the retry ends: %s", async (_case, refusedAgain, outcome) => {
    const first = Promise.withResolvers<Response>();
    const run = await pairing(undefined, { peer: (read) => read === 1 ? first.promise : Promise.resolve(peerStatus(refusedAgain)) });
    const wait = enrollmentWait();
    run.enrollment.resolve(Response.json({ results: [] }));
    first.resolve(peerStatus(true));
    const fire = await wait;
    // the first pairing entered the PC before the enrollment read the other PCs: no Ready screen, the app is open
    expect([run.apps(), run.kinds.includes("ready")]).toEqual([1, false]);
    const notice = () => markup(createElement(OpenPcEnrollmentNotice));
    expect(/data-enrollment-notice="" data-kind="(\w+)" data-seconds="(\d+)">[\s\S]*?<span>([^<]*)</.exec(notice())?.slice(1).map((part, index) => index < 2 ? part : part.includes("42"))).toEqual(["waiting", "42", true]);
    // a waiting notice cannot be dismissed: it goes when the wait does
    expect(notice()).not.toContain("<button");
    fire();
    await run.when(() => JSON.stringify(run.saved()).includes(`"${outcome}"`), `the enrollment ended ${outcome} after its wait`);
    expect([run.peerReads(), notice()]).toEqual([2, ""]);
  });

  it("shows no wait on a page loaded while an enrollment waits, and that enrollment asks the limited PC once more after the wait", async () => {
    const first = Promise.withResolvers<Response>();
    const run = await pairing(undefined, { peer: (read) => read === 1 ? first.promise : Promise.resolve(peerStatus(false)) });
    const wait = enrollmentWait();
    run.enrollment.resolve(Response.json({ results: [] }));
    first.resolve(peerStatus(true));
    const fire = await wait;
    expect([run.peerReads(), run.enrolls(), run.saved()]).toEqual([1, 0, { account: "acct-test", state: "pending" }]);
    // the page is loaded again (here: a second page on the same saved PCs) while the first one's enrollment waits
    await run.mountAt("https://app.ovis.sh/");
    const listed = () => { const state = run.current().state; return state.kind === "list" && state.account?.kind === "signed-in" && state.account.pcs !== null ? state.account.pcs : null; };
    await run.when(() => listed() !== null, "the loaded page listed the account's PCs");
    const table = markup(createElement(RelayPcTable, { rows: dashboardModel(dashboardPcs(listed() ?? [], run.devices()), { label: "Phone", now: Date.now() }, "wss://relay.ovis.sh").rows, onSelect() {}, onOpenSheet() {} }));
    const lines = [...table.matchAll(/data-pc-enrollment=""([^>]*)>([^<]+)</g)].map(([, attributes, words]) => [attributes, words?.includes("42")]);
    // nothing on it speaks of the wait: no page of its own waits
    expect(lines).toEqual([["", false]]);
    expect(table).not.toContain("data-enrollment-wait");
    fire();
    await run.when(() => JSON.stringify(run.saved()).includes('"complete"'), "the enrollment completed after its wait");
    expect([run.peerReads(), run.enrolls(), run.saved()]).toEqual([2, 1, { account: "acct-test", state: "complete" }]);
  });

  it("says live on the Ready screen how long the account service asked to wait, and after a second refusal ends failed with no wait left", async () => {
    const second = Promise.withResolvers<Response>();
    const reads = [Promise.resolve(peerStatus(false)), second.promise, Promise.resolve(peerStatus(true))];
    const run = await pairing(undefined, { peer: (read) => reads[read - 1] ?? Promise.reject(new TypeError("one more read than the test allows")) });
    // the first attempt fails at the enrollment itself; the next open of the PC stops at Ready and tries again
    run.enrollment.resolve(Response.json({ error: { code: "account_unavailable" } }, { status: 503 }));
    await run.when(() => JSON.stringify(run.saved()).includes('"failed"'), "the first attempt failed");
    run.retrySuccess();
    const wait = enrollmentWait();
    await run.mountAt(run.pcPage);
    await run.when(() => run.peerReads() === 2, "the retry read the other PC");
    second.resolve(peerStatus(true));
    const fire = await wait;
    const ready = () => { const state = run.current().state; return state.kind === "ready" ? state : undefined; };
    const sheet = () => { const state = ready(); return markup(createElement(ReadyCheckpoint, { open() {}, cancel() {}, retry() {}, ...(state ? { state } : {}) })); };
    await run.when(() => typeof ready()?.enrollment === "object", "the Ready screen says the wait");
    expect(ready()?.enrollment).toEqual({ state: "waiting", seconds: 42 });
    expect(/data-enrollment-wait="(\d+)"[^>]*>[\s\S]*?<p class="relay-shell-detail">([^<]*)</.exec(sheet())?.slice(1).map((part, index) => index === 0 ? part : part.includes("42"))).toEqual(["42", true]);
    // nothing about the wait is saved: only this page, whose enrollment waits, says it
    expect(run.saved()).toEqual({ account: "acct-test", state: "failed" });
    fire();
    await run.when(() => ready()?.enrollment === "failed", "the Ready screen says the enrollment failed");
    // asked once more, refused again: the enrollment ends as it would have without the wait
    expect([run.peerReads(), run.saved()]).toEqual([3, { account: "acct-test", state: "failed" }]);
    expect(sheet()).not.toContain("data-enrollment-wait");
    expect(sheet()).toContain('data-action="retry-enrollment"');
  });

  it.each([
    ["it waits when it is left", true],
    ["it is refused only after it was left", false],
  ] as const)("says nothing of a wait inside another PC opened in the same page after the enrollment's Ready screen was left: %s", async (_case, waitsFirst) => {
    const second = Promise.withResolvers<Response>();
    const run = await pairing(undefined, { peer: (read) => read === 2 ? second.promise : Promise.resolve(peerStatus(false)) });
    run.enrollment.resolve(Response.json({ error: { code: "account_unavailable" } }, { status: 503 }));
    await run.when(() => JSON.stringify(run.saved()).includes('"failed"'), "the first attempt failed");
    run.retrySuccess();
    const wait = enrollmentWait();
    await run.mountAt(run.pcPage);
    await run.when(() => run.peerReads() === 2, "the retry read the other PC");
    if (waitsFirst) {
      second.resolve(peerStatus(true));
      await run.when(() => { const state = run.current().state; return state.kind === "ready" && typeof state.enrollment === "object"; }, "the Ready screen says the wait");
    }
    // a link of another PC pasted into this tab: the Ready screen is left while its enrollment still waits, and that PC opens here
    const lab = generateKeyPair();
    const link = new URL(encodeOffer({ v: 1, server_id: deriveServerId(lab.publicKey), server_public_key: exportPublicKey(lab.publicKey), relay: "wss://relay.ovis.sh", name: "Lab" }, "https://app.ovis.sh"));
    Object.assign(window.location, { href: link.href, hash: link.hash });
    window.dispatchEvent(new Event("hashchange"));
    await run.when(() => { const state = run.current().state; return state.kind === "confirm" && state.offer.name === "Lab" && state.account !== "checking"; }, "the other PC's confirm");
    run.current().onPair();
    await until(() => run.apps() === 2);
    if (!waitsFirst) second.resolve(peerStatus(true));
    const fire = await wait;
    const notice = () => markup(createElement(OpenPcEnrollmentNotice));
    expect(notice()).toBe("");
    fire();
    await run.when(() => JSON.stringify(run.saved()).includes('"complete"'), "the left PC's enrollment completed after its wait");
    expect(notice()).toBe("");
  });

  it("tells a failed dashboard row to Open it to try again, and that Open retries the enrollment", async () => {
    const run = await pairing();
    run.enrollment.resolve(Response.json({ error: { code: "account_unavailable" } }, { status: 503 }));
    await until(async () => (await run.rows())[0]?.enrollment === "failed");
    const model = dashboardModel(await run.dashboard(), { label: "Phone", now: Date.now() }, "wss://relay.ovis.sh");
    const html = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayPcTable, { rows: model.rows, onSelect() {}, onOpenSheet() {} }) }));
    const action = /<a[^>]*href="([^"]+)"[^>]*data-pc-action="open"[^>]*>([^<]+)<\/a>/.exec(html);
    const line = /data-pc-enrollment="">([^<]+)</.exec(html)?.[1];
    expect(action?.[2]).toBe("Open");
    expect(line).toBe("Account setup is incomplete. Open it to try again.");
    // Open is a link to the PC's own page, which retries the saved failed enrollment as it opens
    const before = run.enrolls();
    run.retrySuccess();
    await run.mountAt(new URL(action?.[1] ?? "/", "https://app.ovis.sh").href);
    await until(() => run.enrolls() > before);
    await until(async () => (await run.rows())[0]?.enrollment === "complete");
  });
});
