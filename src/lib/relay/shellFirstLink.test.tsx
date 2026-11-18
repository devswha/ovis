import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { ACCOUNT_FEATURE, MuxProtocolError, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { relayFailureText } from "../../components/relayFailureText.ts";
import { memoryAccountStore } from "../account/store.ts";
import { translate, type Vars } from "../i18n.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { RelayDevice, ShellDeviceStore, SavedDevice } from "./device.ts";
import { ADMISSION_WAIT_MS, LINK_RETRY_MAX_MS } from "./accountController.ts";
import { mountRelayShell } from "./shell.tsx";
import { createShellTestPage } from "./shell.test.tsx";
import { RelayTransport, type RelayTransportOptions } from "./transport.ts";

const t = (key: string, vars?: Vars): string => translate("en", key, vars);
const OLDER_ID = "12".repeat(8);
const NEWER_ID = "34".repeat(8);
// a newer pairing of the same PC that another tab saved
const REPLACED_ID = "56".repeat(8);

async function until(holds: () => boolean | Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) { if (await holds()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  throw new Error("The pairing did not reach the expected state");
}

// A device stops before pairing only for a code that
// carries the mark `admission: 1`. Then, signed in, it lists the PC when its account does not list it yet, posts its
// admission and has it answered, and only then pairs and links, all under the sign-in the person said yes under. Any
// other offer pairs as before, posting nothing. A refused link forgets no pairing.
describe("the admission before a first link", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  const transports: RelayTransport[] = [];
  beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
  afterEach(() => { jest.useRealTimers(); for (const transport of transports.splice(0)) transport.close(); setTransport(nativeTransport); browser.dispose(); });

  interface Options {
    /** the offer carries `admission: 1` (a code whose PC checks new devices with the account service) */
    readonly mark?: boolean;
    /** the device already has a pairing for this PC that is not linked to the account */
    readonly saved?: boolean;
    /** that saved pairing says it is a member of this account already */
    readonly member?: boolean;
    /** the PC's own page opens the saved pairing: no offer, no code, no confirm */
    readonly reopen?: boolean;
    /** the offer carries no code: a join of a PC the account lists, by comparing digits */
    readonly codeless?: boolean;
    /** the PC is in the account already, with this device's new row not linked yet */
    readonly pcIn?: boolean;
    /** the account service never answers the admission, and ends it only when its signal aborts */
    readonly neverAnswers?: "admission";
    /** the confirm is not pressed: the test presses it (to install fake timers first) */
    readonly hold?: boolean;
    /** another tab forgets this PC just as the older record is about to be written back */
    readonly forgetAtRestore?: boolean;
    /** another tab saves a newer pairing of this PC just as the older record is about to be written back */
    readonly replaceAtRestore?: boolean;
    /** another tab saves a newer pairing of this PC just as this tab begins to forget it */
    readonly replaceAtForget?: boolean;
    /** the second admission (the changed key's) waits until the test releases it */
    readonly holdSecondPost?: boolean;
    /** the first read of the saved record after the PAIR waits until the test releases it */
    readonly holdReadAfterPair?: boolean;
    /** the PC ends the new row's sessions just before it answers the first link, so that end arrives first */
    readonly endRowBeforeAnswer?: boolean;
    /** another tab signs in to another account once the first admission was answered */
    readonly switchAfterAdmission?: boolean;
    /** the account lists the PC already */
    readonly listed?: boolean;
    /** no sign-in is stored on the device */
    readonly signedOut?: boolean;
    /** a leave in another tab replaces the stored account key once the first admission was answered */
    readonly keyChanges?: boolean;
    /** the account service's answer to PUT /v1/pcs/:id */
    readonly listing?: () => Response;
    /** its answer to POST /v1/admissions, by default the repository's fake's (400 `unknown_pc` for a PC the account does not list); "unanswered": it never arrives */
    readonly admission?: () => Response | "unanswered";
    /** the PC's answers to POST /api/account/link, one per link sent, the last one again; by default it takes it, as a PC that asks the account service nothing does */
    readonly links?: readonly (() => Response)[];
  }

  async function pairing(options: Options = {}) {
    const identity = generateKeyPair();
    const offer = { v: 1 as const, server_id: deriveServerId(identity.publicKey), server_public_key: exportPublicKey(identity.publicKey), relay: "wss://relay.ovis.sh", name: "Desk", ...(options.codeless ? {} : { code: "123456" }), ...(options.mark ? { admission: 1 as const } : {}) };
    const accountStore = memoryAccountStore();
    const sessionOf = (account: string) => ({ service: "https://account.ovis.sh", account, provider: "github" as const, access_token: `access-${account}`, refresh_token: `refresh-${account}`, expires_at: Date.now() + 3_600_000 });
    if (!options.signedOut) await accountStore.set("session", sessionOf("acct-test"));
    const key = await accountStore.key();
    const { code: _code, admission: _mark, ...pairedOffer } = offer;
    const older: RelayDevice = { ...pairedOffer, device_id: OLDER_ID, private_key: key.private_key, public_spki: key.public_spki, label: "Phone", ...(options.member ? { account: "acct-test" } : {}) };
    const devices = new Map<string, RelayDevice>(options.saved || options.reopen ? [[offer.server_id, older]] : []);
    const newer: RelayDevice = { ...older, device_id: REPLACED_ID };
    const readHeld = Promise.withResolvers<void>(), readRelease = Promise.withResolvers<void>();
    const secondPostHeld = Promise.withResolvers<void>(), secondPostRelease = Promise.withResolvers<void>();
    let readsHeld = 0;
    // another tab's write that commits just before this tab's own delete of the record
    const replaceFirst = (id: string): void => { if (options.replaceAtForget && devices.get(id)?.device_id === NEWER_ID) devices.set(id, newer); };
    const store: ShellDeviceStore = {
      get: async (id) => {
        if (options.holdReadAfterPair && events.includes("pair") && readsHeld++ === 0) { readHeld.resolve(); await readRelease.promise; }
        return devices.get(id);
      },
      list: async () => [...devices.values()],
      remove: async (id) => { replaceFirst(id); devices.delete(id); },
      removeRow: async (id, row) => { replaceFirst(id); if (devices.get(id)?.device_id !== row) return false; devices.delete(id); return true; },
      update: async (id, change) => {
        // the write that would put the older record back: another tab's Forget, or newer pairing, commits just before it
        if ((options.forgetAtRestore || options.replaceAtRestore) && devices.get(id)?.device_id === NEWER_ID) {
          let next: RelayDevice | undefined;
          try { next = change(devices.get(id)); } catch { next = undefined; }
          if (next?.device_id === OLDER_ID) { if (options.forgetAtRestore) devices.delete(id); else devices.set(id, newer); }
        }
        const device = change(devices.get(id)); devices.set(id, device); return device;
      },
    };
    // what reached the account service and the PC, in order, with the keys each admission and link named
    const events: string[] = [];
    const posted: string[] = [];
    // whether each admission asked to be taken without telling the account's other devices
    const quiet: boolean[] = [];
    const sent: string[] = [];
    const admissionGate = Promise.withResolvers<void>();
    let listed = options.listed === true;
    let postSignal: AbortSignal | undefined;
    let apps = 0, opens = 0, linked = false;
    // the row the PC ended, by its device id: a sign-in with that row is refused, one with another row is not
    let ended: string | null | undefined;
    const fatal: ((error: Error) => void)[] = [];
    class Admitted extends RelayTransport {
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL, features: [ACCOUNT_FEATURE] }; }
      override async renew() {}
      override async fetch(path: string, init?: RequestInit) {
        switch (path) {
          case "/api/account/status": return Response.json({ account: linked || options.pcIn ? "acct-test" : null, unlinked: options.pcIn && !linked ? [NEWER_ID, OLDER_ID] : [], removals: [], enrolling: !linked && !options.pcIn });
          case "/api/account/link": {
            events.push("link");
            if (options.endRowBeforeAnswer && sent.length === 0) endRow();
            sent.push((JSON.parse(String(init?.body)) as { record: { key: string } }).record.key);
            const answers = options.links ?? [];
            const answer = answers[Math.min(sent.length, answers.length) - 1]?.() ?? Response.json({});
            if (answer.ok) linked = true;
            return answer;
          }
          case "/api/account/enroll": return Response.json({ results: [] });
          case "/api/account/introduction": return Response.json({ pcs: [] });
          default: throw new TypeError(`Unexpected PC request: ${path}`);
        }
      }
    }
    let props: RelayShellProps | undefined;
    const render = (node: ReactNode): void => {
      if (!isValidElement<{ readonly children?: ReactNode }>(node)) throw new TypeError("Missing shell element");
      if (node.type === RelayShell && isValidElement<RelayShellProps>(node)) { props = node.props; return; }
      render(node.props.children);
    };
    const current = (): RelayShellProps => { if (!props) throw new TypeError("Shell not rendered"); return props; };
    const listedPc = { server_id: offer.server_id, label: "Desk", added_at: "2026-11-01T00:00:00Z", last_seen_at: null };
    await mountRelayShell({
      container: Object.create(null), entryUrl: options.reopen ? `https://app.ovis.sh/s/${offer.server_id}/` : encodeOffer(offer, "https://app.ovis.sh"), shellVersion: "1.0.0", store, accountStore,
      accountService: "https://account.ovis.sh",
      accountFetch: async (input, init) => {
        const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
        const bearer = new Headers(init?.headers).get("authorization");
        // a call that is never answered ends only by its own signal, as fetch does
        const hung = (): Promise<Response> => new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        if (path === `/v1/pcs/${offer.server_id}` && init?.method === "PUT") {
          events.push(`list ${bearer}`);
          const answer = options.listing?.() ?? Response.json({});
          if (answer.ok) listed = true;
          return answer;
        }
        if (path !== "/v1/admissions" || init?.method !== "POST") {
          return Response.json({ pcs: listed ? [listedPc] : [] });
        }
        events.push(`admission ${bearer}`);
        const body = JSON.parse(String(init.body)) as { key: string; quiet?: unknown };
        posted.push(body.key);
        quiet.push(body.quiet === true);
        postSignal = init.signal ?? undefined;
        if (options.neverAnswers === "admission") return hung();
        if (options.holdSecondPost && posted.length === 2) { secondPostHeld.resolve(); await secondPostRelease.promise; }
        await admissionGate.promise;
        const answer = options.admission?.() ?? (listed ? Response.json({ id: "adm-1" }) : Response.json({ error: { code: "unknown_pc", message: "List PCs of this account only" } }, { status: 400 }));
        if (answer === "unanswered") throw new TypeError("Failed to fetch");
        events.push(answer.ok ? "admission answered" : "admission refused");
        if (options.keyChanges && posted.length === 1) await accountStore.clear(() => true);
        if (options.switchAfterAdmission && answer.ok) await accountStore.set("session", sessionOf("acct-other"));
        return answer;
      },
      createRoot: () => ({ render, unmount() {} }), renderApp: () => { apps++; return { render() {}, unmount() {} }; },
      pendingPush: { get: async () => undefined, clear: async () => {} }, navigate() {}, checkPc: async () => ({ kind: "offline", reason: "relay" }),
      // a pairing (the offer carries the code) saves a new row's record for this device in place of any, as PAIR does;
      // a sign-in with what is saved is refused once the PC ended the row
      open: async (opening, transportOptions: RelayTransportOptions = {}) => {
        opens++;
        if (opening.code !== undefined) { events.push("pair"); devices.set(offer.server_id, { ...older, device_id: NEWER_ID }); }
        else if (ended !== undefined && devices.get(offer.server_id)?.device_id === ended) throw new MuxProtocolError("auth_failed", "the PC ended this row");
        else devices.set(offer.server_id, devices.get(offer.server_id) ?? older);
        if (transportOptions.onFatal) fatal.push(transportOptions.onFatal);
        const opened = new Admitted(offer); transports.push(opened); return opened;
      },
    });
    const press = (): void => { events.push("pressed"); current().onPair(); };
    if (!options.reopen) {
      await until(() => current().state.kind === "confirm" && (current().state as { account?: string }).account !== "checking");
      if (!options.hold) press();
    }
    const pcEvents = (): string[] => events.filter((event) => event === "pair" || event === "link");
    const failure = (): string | null => { const state = current().state; return state.kind === "failed" ? state.failure : null; };
    /** the PC ends the row: every session of it ends `auth_revoked`, and a later sign-in with it is refused */
    const endRow = (): void => { ended = devices.get(offer.server_id)?.device_id; for (const end of fatal.splice(0)) end(new MuxProtocolError("auth_revoked", "the PC ended this row")); };
    const switchAccount = (): Promise<void> => accountStore.set("session", sessionOf("acct-other"));
    return { current, press, switchAccount, readHeld: readHeld.promise, releaseRead: () => readRelease.resolve(), secondPostHeld: secondPostHeld.promise, releaseSecondPost: () => secondPostRelease.resolve(), events, pcEvents, posted, quiet, sent, failure, endRow, admissionGate, store, offer, apps: () => apps, opens: () => opens, postSignal: () => postSignal };
  }

  for (const [what, options, expected] of [
    ["a PC the account does not list yet", {}, ["list Bearer access-acct-test", "admission Bearer access-acct-test", "admission answered", "pair", "link"]],
    ["a PC this device has a pairing with that is not linked, which the account lists", { saved: true, listed: true }, ["admission Bearer access-acct-test", "admission answered", "pair", "link"]],
    // a marked PAIR makes a new row on the PC, whatever this device saved: the saved record decides nothing
    ["a PC this device's saved pairing says it is a member of already", { saved: true, member: true, listed: true }, ["admission Bearer access-acct-test", "admission answered", "pair", "link"]],
  ] as const) {
    it(`with the mark, has the post answered before any PAIR or link: ${what}`, async () => {
      const run = await pairing({ mark: true, ...options });
      await until(() => run.posted.length === 1);
      // the post is out and not answered: nothing reaches the PC meanwhile, and the post can be ended at its bound
      expect(run.opens()).toBe(0);
      expect(run.postSignal()).toBeInstanceOf(AbortSignal);
      run.admissionGate.resolve();
      await until(() => run.apps() === 1 && run.sent.length === 1);
      expect(run.events.filter((event) => event !== "pressed").slice(0, expected.length)).toEqual([...expected]);
      // a marked code is a new PC's: its admission asks to be taken without telling the account's other devices
      expect(run.quiet).toEqual([true]);
    });
  }

  it("with the mark, ends the post itself when the person cancels while it waits, and pairs nothing", async () => {
    const run = await pairing({ mark: true, listed: true });
    await until(() => run.posted.length === 1);
    run.current().onCancel();
    expect(run.postSignal()?.aborted).toBe(true);
    run.admissionGate.resolve();
    expect(run.opens()).toBe(0);
  });

  for (const [what, options, failure] of [
    ["no sign-in", { signedOut: true }, "sign-in-first"],
    ["400 unknown_pc", { listed: true, admission: () => Response.json({ error: { code: "unknown_pc" } }, { status: 400 }) }, "account-unlisted"],
    ["429 too_many_admissions", { listed: true, admission: () => Response.json({ error: { code: "too_many_admissions" } }, { status: 429 }) }, "account-busy"],
    ["503", { listed: true, admission: () => Response.json({ error: { code: "unavailable" } }, { status: 503 }) }, "admission-unanswered"],
    ["no answer", { listed: true, admission: () => "unanswered" as const }, "admission-unanswered"],
    ["400 invalid_key", { listed: true, admission: () => Response.json({ error: { code: "invalid_key" } }, { status: 400 }) }, "admission-failed"],
  ] as const) {
    it(`with the mark, sends no PAIR on ${what}, and says why`, async () => {
      const run = await pairing({ mark: true, ...options });
      run.admissionGate.resolve();
      await until(() => run.current().state.kind === "failed");
      expect(run.failure()).toBe(failure);
      expect(run.opens()).toBe(0);
      const said = relayFailureText(t, failure, "Desk");
      expect(said.title).not.toBe(relayFailureText(t, "relay-unreachable", "Desk").title);
      expect(said.retry).toBe(failure !== "sign-in-first");
    });
  }

  // the account service answers as the repository's fake does, or not at all; neither is asked
  for (const [what, options] of [["a PC the account does not list", {}], ["an account service that does not answer", { admission: () => "unanswered" as const }]] as const) {
    it(`without the mark, posts nothing and pairs and links as before: ${what}`, async () => {
      const run = await pairing(options);
      await until(() => run.apps() === 1 && run.sent.length === 1);
      expect(run.posted).toEqual([]);
      // nothing reaches the account service before the pairing
      expect(run.events.slice(0, run.events.indexOf("pair")).filter((event) => event.startsWith("list") || event.startsWith("admission"))).toEqual([]);
      expect(run.pcEvents()).toEqual(["pair", "link"]);
    });
  }

  it("without a code, a join by comparing digits posts an ordinary admission as before, never a quiet one", async () => {
    const run = await pairing({ codeless: true, listed: true });
    await until(() => run.posted.length === 1);
    run.admissionGate.resolve();
    expect(run.quiet).toEqual([false]);
    expect(run.events.filter((event) => event.startsWith("list"))).toEqual([]);
  });

  it("with the mark, stops when the stored sign-in changed since the press: nothing is posted under the other", async () => {
    const run = await pairing({ mark: true, listed: true, hold: true });
    run.press();
    await run.switchAccount();
    run.admissionGate.resolve();
    // the question is asked again, under the sign-in stored now
    await until(() => run.current().state.kind === "confirm" && (run.current().state as { account?: string }).account !== "checking");
    expect(run.posted).toEqual([]);
    expect(run.opens()).toBe(0);
  });

  it("with the mark, posts the key the link will name when the account key changed after the post, once, and stops when that link is refused too", async () => {
    const run = await pairing({ mark: true, listed: true, keyChanges: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    run.admissionGate.resolve();
    await until(() => run.current().state.kind === "failed");
    expect(run.posted).toHaveLength(2);
    expect(run.posted[1]).not.toBe(run.posted[0]);
    expect(run.quiet).toEqual([true, true]);
    expect(run.sent).toEqual(run.posted.slice(1));
    expect(run.failure()).toBe("unverified-device");
  });

  it("with the mark, sends no link when the post of the changed key fails, and says why", async () => {
    let posts = 0;
    const run = await pairing({ mark: true, listed: true, keyChanges: true, admission: () => ++posts === 1 ? Response.json({ id: "adm-1" }) : Response.json({ error: { code: "unavailable" } }, { status: 503 }) });
    run.admissionGate.resolve();
    await until(() => run.current().state.kind === "failed");
    expect(run.posted).toHaveLength(2);
    // the PC would refuse that link and spend a use: none is sent
    expect(run.sent).toEqual([]);
    expect(run.failure()).toBe("new-key-unvouched");
  });

  it("sends the same link again on the same session after the wait a 503 account_unavailable named, and pairs once", async () => {
    const run = await pairing({ mark: true, listed: true, links: [() => Response.json({ error: { code: "account_unavailable" } }, { status: 503, headers: { "retry-after": "3" } }), () => Response.json({})] });
    jest.useFakeTimers();
    run.admissionGate.resolve();
    for (let turn = 0; run.sent.length < 1 && turn < 5_000; turn++) await crypto.subtle.digest("SHA-256", new Uint8Array(1));
    for (let turn = 0; run.sent.length < 2 && turn < 5_000; turn++) {
      jest.advanceTimersByTime(1_000);
      await crypto.subtle.digest("SHA-256", new Uint8Array(1));
    }
    expect(run.sent).toHaveLength(2);
    expect(run.pcEvents().filter((event) => event === "pair")).toHaveLength(1);
  });

  // a marked pairing's first link the PC turned away: the refusal is said, and the record of the row it ended goes
  for (const [code, status, failure] of [["link_required", 403, "link-required"], ["account_mismatch", 409, "account-mismatch"], ["unverified_device", 403, "unverified-device"]] as const) {
    it(`says a new marked pairing's refused link (${code}) in its own words, opens no app, and forgets the row the PC ended`, async () => {
      const run = await pairing({ mark: true, listed: true, links: [() => Response.json({ error: { code, message: "private refusal" } }, { status })] });
      run.admissionGate.resolve();
      await until(() => run.current().state.kind === "failed");
      expect(run.failure()).toBe(failure);
      expect(run.apps()).toBe(0);
      expect(await run.store.get(run.offer.server_id)).toBeUndefined();
      const said = relayFailureText(t, failure, "Desk");
      expect(said.title).not.toBe(relayFailureText(t, "revoked", "Desk").title);
      expect(JSON.stringify(said)).not.toContain("private refusal");
    });
    // an unmarked pairing's refused link goes as before: the PC opens, and its record goes only once the PC ends the
    // row (a PC that was set up for another account and is in none keeps it, and the device drives on)
    it(`opens the PC as before when an unmarked pairing's link is refused ${code}, and forgets its record once the PC ends the row`, async () => {
      const run = await pairing({ links: [() => Response.json({ error: { code } }, { status })] });
      await until(() => run.apps() === 1 && run.sent.length === 1);
      expect(run.failure()).toBeNull();
      expect((await run.store.get(run.offer.server_id))?.device_id).toBe(NEWER_ID);
      run.endRow();
      await until(async () => await run.store.get(run.offer.server_id) === undefined);
    });
  }

  // a PC already in an account keeps a row whose link names another account, and the device drives it as before
  for (const mark of [false, true]) {
    it(`opens the PC as before when a PC already in an account answers the link account_mismatch (${mark ? "marked" : "plain"} code)`, async () => {
      const run = await pairing({ mark, pcIn: true, listed: true, links: [() => Response.json({ error: { code: "account_mismatch" } }, { status: 409 })] });
      run.admissionGate.resolve();
      await until(() => run.apps() === 1 && run.sent.length === 1);
      expect(run.failure()).toBeNull();
      expect((await run.store.get(run.offer.server_id))?.device_id).toBe(NEWER_ID);
    });
  }

  // a hung account service holds a marked pairing no longer than its bound, and nothing reaches the PC
  const turn = () => crypto.subtle.digest("SHA-256", new Uint8Array(1));
  for (const [hung, failure, options] of [["admission", "admission-unanswered", { listed: true }]] as const) {
    it(`with the mark, stops at the bound when the account service never answers the ${hung}, and sends no PAIR`, async () => {
      const run = await pairing({ mark: true, hold: true, neverAnswers: hung, ...options });
      jest.useFakeTimers();
      run.press();
      const asked = (): boolean => run.posted.length === 1;
      for (let step = 0; !asked() && step < 5_000; step++) await turn();
      expect(asked()).toBe(true);
      expect(run.current().state.kind).toBe("connecting");
      jest.advanceTimersByTime(ADMISSION_WAIT_MS);
      for (let step = 0; run.current().state.kind !== "failed" && step < 5_000; step++) await turn();
      expect(run.failure()).toBe(failure);
      expect(run.opens()).toBe(0);
    });
  }

  // a PC that keeps answering account_unavailable gets the link a bounded number of times, each after a bounded wait
  it("with the mark, sends the link five times to a PC that keeps answering account_unavailable, then records the enrollment as failed", async () => {
    const run = await pairing({ mark: true, listed: true, hold: true, links: [() => Response.json({ error: { code: "account_unavailable" } }, { status: 503 })] });
    jest.useFakeTimers();
    run.press();
    run.admissionGate.resolve();
    let state: string | undefined;
    for (let step = 0; state !== "failed" && step < 20_000; step++) {
      if (step % 4 === 3) jest.advanceTimersByTime(1_000);
      await turn();
      state = ((await run.store.get(run.offer.server_id)) as SavedDevice | undefined)?.account_enrollment?.state;
    }
    expect(state).toBe("failed");
    expect(run.sent).toHaveLength(5);
    expect(run.pcEvents().filter((event) => event === "pair")).toHaveLength(1);
  });

  it("waits no longer than its cap before sending the link again, whatever wait the PC names", async () => {
    const run = await pairing({ mark: true, listed: true, hold: true, links: [() => Response.json({ error: { code: "account_unavailable" } }, { status: 503, headers: { "retry-after": "3600" } }), () => Response.json({})] });
    jest.useFakeTimers();
    run.press();
    run.admissionGate.resolve();
    for (let step = 0; run.sent.length < 1 && step < 5_000; step++) await turn();
    expect(run.sent).toHaveLength(1);
    jest.advanceTimersByTime(LINK_RETRY_MAX_MS);
    for (let step = 0; run.sent.length < 2 && step < 5_000; step++) await turn();
    expect(run.sent).toHaveLength(2);
  });

  // without the mark a link goes as before: once, unless the PC named a wait
  for (const [what, headers, expected] of [["names no wait", {}, 1], ["names a wait", { "retry-after": "1" }, 2]] as const) {
    it(`without the mark, sends the link again only when the PC ${what}`, async () => {
      const run = await pairing({ hold: true, links: [() => Response.json({ error: { code: "account_unavailable" } }, { status: 503, headers }), () => Response.json({})] });
      jest.useFakeTimers();
      run.press();
      for (let step = 0; run.sent.length < 1 && step < 5_000; step++) await turn();
      for (let step = 0; step < 400; step++) { if (step % 4 === 3) jest.advanceTimersByTime(1_000); await turn(); }
      expect(run.sent).toHaveLength(expected);
    });
  }

  for (const [code, status] of [["unverified_device", 403], ["account_mismatch", 409], ["pairing_ended", 409]] as const) {
    it(`keeps a saved pairing reopened without a code, and opens the PC, when its link is refused ${code}`, async () => {
      const run = await pairing({ reopen: true, links: [() => Response.json({ error: { code } }, { status })] });
      await until(() => run.apps() === 1 && run.sent.length === 1);
      expect((await run.store.get(run.offer.server_id))?.device_id).toBe(OLDER_ID);
    });
  }

  it("forgets the pairing once the PC ends the row", async () => {
    const run = await pairing({ reopen: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    await until(() => run.apps() === 1 && run.sent.length === 1);
    run.endRow();
    await until(async () => await run.store.get(run.offer.server_id) === undefined);
  });

  it("keeps the older record of a saved pairing that paired again from a marked code whose new link was refused, and opens the PC with it", async () => {
    const run = await pairing({ mark: true, saved: true, listed: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    run.admissionGate.resolve();
    await until(() => run.apps() === 1);
    expect((await run.store.get(run.offer.server_id))?.device_id).toBe(OLDER_ID);
  });

  // the mark comes with the QR code, which nothing signs: it only chooses the confirm. The person's press of Add and pair
  // on that confirm, which names the PC and the account, lists a PC the account does not list yet; then the admission
  // goes, then the PAIR
  it("with the mark, lists a PC the account does not list once Add and pair is pressed, then posts, pairs and links", async () => {
    const run = await pairing({ mark: true });
    run.admissionGate.resolve();
    await until(() => run.apps() === 1 && run.sent.length === 1);
    // the enrollment lists the PC again once the link passed, as for any pairing; these are the steps before it
    expect(run.events.filter((event) => event !== "pressed").slice(0, 5)).toEqual(["list Bearer access-acct-test", "admission Bearer access-acct-test", "admission answered", "pair", "link"]);
    expect(run.events.indexOf("pressed")).toBeLessThan(run.events.indexOf("list Bearer access-acct-test"));
    expect(run.failure()).toBeNull();
  });

  it("with the mark, lists nothing and posts nothing while Add and pair is not pressed", async () => {
    const run = await pairing({ mark: true, hold: true });
    run.admissionGate.resolve();
    for (let step = 0; step < 400; step++) await turn();
    expect(run.current().state.kind).toBe("confirm");
    expect(run.events.filter((event) => event.startsWith("list") || event.startsWith("admission"))).toEqual([]);
    expect(run.posted).toEqual([]);
    expect(run.opens()).toBe(0);
  });

  // another tab signs out of, or into another account than, the one the confirm named while the post is out: no PAIR
  it("with the mark, sends no PAIR when the stored sign-in changed while the admission was out, and asks again", async () => {
    const run = await pairing({ mark: true, listed: true, switchAfterAdmission: true });
    run.admissionGate.resolve();
    await until(() => run.posted.length === 1 && run.current().state.kind === "confirm" && (run.current().state as { account?: string }).account !== "checking");
    expect(run.opens()).toBe(0);
  });

  it("with the mark, sends the link no more once the stored sign-in changed while it waited to send it again", async () => {
    const run = await pairing({ mark: true, listed: true, hold: true, links: [() => Response.json({ error: { code: "account_unavailable" } }, { status: 503, headers: { "retry-after": "2" } }), () => Response.json({})] });
    jest.useFakeTimers();
    run.press();
    run.admissionGate.resolve();
    for (let step = 0; run.sent.length < 1 && step < 5_000; step++) await turn();
    expect(run.sent).toHaveLength(1);
    await run.switchAccount();
    jest.advanceTimersByTime(LINK_RETRY_MAX_MS);
    for (let step = 0; step < 400; step++) await turn();
    expect(run.sent).toHaveLength(1);
  });

  // a marked re-pair whose new link is refused restores the older record only while the refused row still holds it
  it("keeps a Forget that another tab makes as a marked re-pair's refusal is handled, and writes no older record over it", async () => {
    const run = await pairing({ mark: true, saved: true, listed: true, forgetAtRestore: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    run.admissionGate.resolve();
    await until(() => run.sent.length === 1);
    for (let step = 0; step < 400; step++) await turn();
    // the older record was not written back over the Forget
    expect(await run.store.get(run.offer.server_id)).toBeUndefined();
  });

  // the PC ends the refused row's sessions as it answers: that end may arrive before the refusal itself
  for (const saved of [true, false]) {
    it(`handles a marked pairing's refusal that arrives after the end of its sessions (${saved ? "a re-pair" : "a new pairing"})`, async () => {
      const run = await pairing({ mark: true, saved, listed: true, endRowBeforeAnswer: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
      run.admissionGate.resolve();
      if (saved) {
        await until(() => run.apps() === 1);
        expect((await run.store.get(run.offer.server_id))?.device_id).toBe(OLDER_ID);
      } else {
        await until(() => run.current().state.kind === "failed");
        expect(run.failure()).toBe("unverified-device");
        expect(await run.store.get(run.offer.server_id)).toBeUndefined();
        // the PAIR and the link's own connection, and no sign-in again with the key of a row the PC turned away
        expect(run.opens()).toBe(2);
      }
    });
  }

  // a Cancel ends the attempt wherever it waits: it sends no link, opens no app, and writes nothing after it
  for (const mark of [true, false]) {
    it(`sends no link and opens nothing after a Cancel while the PAIR's record is read (${mark ? "marked" : "plain"} code)`, async () => {
      const run = await pairing({ mark, listed: true, holdReadAfterPair: true });
      run.admissionGate.resolve();
      await run.readHeld;
      run.current().onCancel();
      run.releaseRead();
      for (let step = 0; step < 400; step++) await turn();
      expect(run.sent).toEqual([]);
      expect(run.apps()).toBe(0);
    });
  }

  it("with the mark, sends no link again and records nothing after a Cancel while a link waits to be sent again", async () => {
    const run = await pairing({ mark: true, listed: true, hold: true, links: [() => Response.json({ error: { code: "account_unavailable" } }, { status: 503, headers: { "retry-after": "2" } }), () => Response.json({})] });
    jest.useFakeTimers();
    run.press();
    run.admissionGate.resolve();
    for (let step = 0; run.sent.length < 1 && step < 5_000; step++) await turn();
    expect(run.sent).toHaveLength(1);
    const before = ((await run.store.get(run.offer.server_id)) as SavedDevice | undefined)?.account_enrollment?.state;
    run.current().onCancel();
    jest.advanceTimersByTime(LINK_RETRY_MAX_MS);
    for (let step = 0; step < 400; step++) await turn();
    expect(run.sent).toHaveLength(1);
    expect(run.apps()).toBe(0);
    expect(((await run.store.get(run.offer.server_id)) as SavedDevice | undefined)?.account_enrollment?.state).toBe(before);
  });

  // a refused first link forgets only the refused row's own record: a newer pairing another tab saved meanwhile stands
  it("keeps a newer pairing another tab saves as the refused row's record is forgotten", async () => {
    const run = await pairing({ mark: true, listed: true, replaceAtForget: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    run.admissionGate.resolve();
    await until(() => run.current().state.kind === "failed");
    expect(run.failure()).toBe("unverified-device");
    expect((await run.store.get(run.offer.server_id))?.device_id).toBe(REPLACED_ID);
  });

  it("keeps a newer pairing another tab saves as a re-pair's older record would be written back, when the end of its sessions came first", async () => {
    const run = await pairing({ mark: true, saved: true, listed: true, endRowBeforeAnswer: true, replaceAtRestore: true, links: [() => Response.json({ error: { code: "unverified_device" } }, { status: 403 })] });
    run.admissionGate.resolve();
    await until(() => run.current().state.kind === "failed");
    expect((await run.store.get(run.offer.server_id))?.device_id).toBe(REPLACED_ID);
  });

  it("with the mark, ends the changed key's admission when the person cancels while it is out, and sends no link", async () => {
    const run = await pairing({ mark: true, listed: true, keyChanges: true, holdSecondPost: true });
    run.admissionGate.resolve();
    await run.secondPostHeld;
    run.current().onCancel();
    expect(run.postSignal()?.aborted).toBe(true);
    run.releaseSecondPost();
    for (let step = 0; step < 400; step++) await turn();
    expect(run.sent).toEqual([]);
    expect(run.apps()).toBe(0);
  });
});
