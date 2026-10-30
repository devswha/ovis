/**
 * The hosted shell in a real browser against a real PC: dist-shell/ served as Cloudflare Pages
 * would serve it (pages-static.ts) under its enforced policy, a real `createServer` on the
 * isolated herdr test session with its relay turned on, and the Bun relay (relay/bun.ts) between
 * them. Run after `bun run build:shell`.
 *
 * The shell accepts only a wss: relay, and the PC's server only a wss: relay origin, so both name
 * `wss://relay.test`: the server's outbound sockets reach the local relay through the service's
 * `connect` seam, and the browser's through Playwright's WebSocket routing, bridged here frame by
 * frame to the same relay. The bridge can also hold a connection, stay silent, or find the relay
 * gone, which is how the states no happy path reaches are driven.
 *
 *   UI_EVIDENCE_DIR=<dir> bun scripts/relay-shell-browser-qa.ts
 *
 * writes the screenshots and logs there (task-16-*); without it the checks still run.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import type { BunRelay } from "../relay/bun.ts";
import { createServer } from "../server/index.ts";
import { RelayService } from "../server/relay/service.ts";
import { shellContentSecurityPolicy } from "../server/static.ts";
import { exportPublicKey, generateKeyPair, openDaemonSecureChannel } from "../shared/relay-e2ee.ts";
import type { SecureChannel, Transport } from "../shared/relay-e2ee.ts";
import { encodeFrame, FrameType } from "../shared/relay-mux.ts";
import { decodeOffer, encodeOffer } from "../shared/relay-offer.ts";
import type { RelayOffer } from "../shared/relay-offer.ts";
import { ADMISSION_MS, ASSIGNMENT_MS, PC_ANSWER_MS } from "../src/lib/relay/channel.ts";
import { chromePath } from "./chrome-path.ts";
import { assertCspClean, watchCsp } from "./csp-violations.ts";
import type { CspWatch } from "./csp-violations.ts";
import { servePagesSite } from "./pages-static.ts";

const repo = join(import.meta.dir, "..");
const evidence = process.env["UI_EVIDENCE_DIR"] ?? null;
if (evidence) mkdirSync(evidence, { recursive: true });
const keep = (name: string, text: string): void => { if (evidence) writeFileSync(join(evidence, name), text); };
const shot = async (page: Page, name: string): Promise<void> => { if (evidence) await page.screenshot({ path: join(evidence, `task-16-${name}.png`) }); };

/** The relay origin both sides are told; nothing listens there, the seam and the bridge do. */
const RELAY = "wss://relay.test";
const OTHER_ID = "fedcba9876543210fedcba9876543210";

function deferred<T>() {
  let resolve = (_value: T): void => {};
  let reject = (_error: unknown): void => {};
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function bounded<T>(promise: Promise<T>, what: string, ms = 20_000): Promise<T> {
  const late = deferred<T>();
  const timer = setTimeout(() => late.reject(new Error(`${what}: not within ${ms} ms`)), ms);
  try { return await Promise.race([promise, late.promise]); } finally { clearTimeout(timer); }
}
async function until(what: string, condition: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(25);
  }
}

// ---- the relay, the PC and its shell host ----

let relay: BunRelay | null = startBunRelay({ port: 0 });
let relayPort = relay.port;
const relayUrl = (url: string): string => { const target = new URL(url); return `ws://127.0.0.1:${relayPort}${target.pathname}${target.search}`; };
let synced = deferred<void>();
const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-shell-qa-"));
const service = new RelayService({ stateDir, relay: RELAY, connect: (url) => {
  const socket = new WebSocket(relayUrl(url));
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string" && event.data.includes('"sync"')) synced.resolve();
  });
  return socket;
} });
const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, relay: service });
const base = `http://127.0.0.1:${app.port}`;
const devices = app.context.services.devices;
const relayApi = (path: string) => fetch(`${base}/api/relay${path}`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
const startPcRelay = async (): Promise<void> => {
  synced = deferred<void>();
  const response = await relayApi("/start");
  const body = await response.text();
  assert.equal(response.status, 200, `relay start: ${body}`);
  await bounded(synced.promise, "the PC's control socket synced with the relay");
  assert.equal(service.status().phase, "online");
};
const stopPcRelay = async (): Promise<void> => {
  assert.equal((await relayApi("/stop")).status, 200);
  assert.equal(service.status().phase, "off");
};
const restartRelay = async (): Promise<void> => {
  synced = deferred<void>();
  relay = startBunRelay({ port: 0 });
  relayPort = relay.port;
  // the PC's link reconnects by itself, with its own backoff
  await bounded(synced.promise, "the PC reconnected to the restarted relay", 45_000);
};

const site = servePagesSite(join(repo, "dist-shell"), 0);
const origin = `http://127.0.0.1:${site.port}`;

/** A fresh pairing offer from the PC, re-based onto the shell host and named for the screens. */
const serverOffer = async (name = "Desk PC"): Promise<RelayOffer> => {
  const response = await relayApi("/offer");
  const body = await response.text();
  assert.equal(response.status, 200, `offer: ${body}`);
  const offer = decodeOffer((JSON.parse(body) as { url: string }).url);
  if (!offer) throw new Error("the PC gave no offer");
  return { ...offer, name };
};
const offerUrl = (offer: RelayOffer): string => encodeOffer(offer, origin);
const scopeOf = (serverId: string): string => `${origin}/s/${serverId}/`;

// ---- the browser side of the relay ----

interface BridgeSocket { url: string; assigned: Promise<void>; pcAnswered: Promise<void> }
/**
 * How a context's relay sockets are treated: carried to the relay as they come, carried once
 * `release` says so, or accepted and never answered. Each socket the page opens is reported.
 */
class Bridge {
  mode: "carry" | "hold" | "silent" = "carry";
  release = deferred<void>();
  readonly sockets: BridgeSocket[] = [];
  private readonly waiters: ((socket: BridgeSocket) => void)[] = [];
  private readonly pending: BridgeSocket[] = [];
  opened(socket: BridgeSocket): void {
    this.sockets.push(socket);
    const waiter = this.waiters.shift();
    if (waiter) waiter(socket); else this.pending.push(socket);
  }
  next(): Promise<BridgeSocket> {
    const ready = this.pending.shift();
    return ready ? Promise.resolve(ready) : new Promise((resolve) => this.waiters.push(resolve));
  }
}

async function bridgeRelay(context: BrowserContext, bridge: Bridge): Promise<void> {
  await context.routeWebSocket(/^wss:\/\/relay\.test\//, (ws) => {
    const assigned = deferred<void>();
    const pcAnswered = deferred<void>();
    bridge.opened({ url: ws.url(), assigned: assigned.promise, pcAnswered: pcAnswered.promise });
    if (bridge.mode === "silent") return;
    const queue: (string | Buffer)[] = [];
    let upstream: WebSocket | null = null;
    let frames = 0;
    const start = (): void => {
      const socket = new WebSocket(relayUrl(ws.url()));
      socket.binaryType = "arraybuffer";
      upstream = socket;
      socket.onopen = () => { for (const frame of queue.splice(0)) socket.send(frame); };
      socket.onmessage = (event) => {
        frames += 1;
        if (frames === 1) assigned.resolve(); else pcAnswered.resolve();
        ws.send(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer));
      };
      socket.onerror = () => {};
      socket.onclose = (event) => {
        // the browser could not be told 1006 by a server; the shell reads any close before assignment the same way
        for (const code of [event.code, 1011]) {
          try { ws.close({ code, reason: event.reason || "relay connection lost" }); return; } catch { /* the next code */ }
        }
      };
    };
    ws.onMessage((message) => { if (upstream?.readyState === WebSocket.OPEN) upstream.send(message); else queue.push(message); });
    ws.onClose(() => upstream?.close());
    if (bridge.mode === "hold") void bridge.release.promise.then(start); else start();
  });
}

// ---- a scripted PC for the refusals the real one never sends to a current shell ----

/**
 * A PC on the relay that completes the real handshake and then either refuses the shell's HELLO
 * with `unsupported_version` (what a PC from another protocol generation answers) or never
 * answers it (a PC that hung). The real server cannot be made to do either to a current shell.
 */
async function scriptedPc(behaviour: "refuse" | "stall", name: string) {
  const keys = generateKeyPair();
  const serverId = randomBytes(16).toString("hex");
  const sockets: WebSocket[] = [];
  const dataFor = (connectionId: string): void => {
    const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/ws?server_id=${serverId}&role=server&connection_id=${connectionId}&v=1`);
    socket.binaryType = "arraybuffer";
    sockets.push(socket);
    const transport: Transport = {
      onmessage: null, onclose: null, onerror: null,
      send: (data) => { socket.send(data); }, close: (code, reason) => socket.close(code, reason),
    };
    socket.onmessage = (event) => transport.onmessage?.({ data: event.data as string | ArrayBuffer, isBinary: typeof event.data !== "string" });
    socket.onclose = (event) => transport.onclose?.(event.code, event.reason);
    let channel: SecureChannel | undefined;
    let incoming = Promise.resolve();
    const opening = openDaemonSecureChannel(transport, { daemonKeyPair: keys, minimumMode: "protected", events: {
      onmessage: () => {
        if (behaviour === "stall") return;
        incoming = incoming.then(async () => {
          await opening;
          await channel?.send(encodeFrame({ type: FrameType.SESSION_ERROR, flags: 0, stream_id: 0,
            payload: { code: "unsupported_version", message: "This PC speaks another relay protocol" } }).slice().buffer);
        }).catch(() => socket.close());
      },
    } }).then((opened) => { channel = opened; return opened; });
    opening.catch(() => socket.close());
  };
  const control = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/ws?server_id=${serverId}&role=server&v=1`);
  sockets.push(control);
  control.onmessage = (event) => {
    const value = JSON.parse(String(event.data)) as { type: string; connection_id?: string; connection_ids?: string[] };
    if (value.type === "sync") for (const id of value.connection_ids ?? []) dataFor(id);
    else if (value.type === "connected" && value.connection_id) dataFor(value.connection_id);
  };
  await bounded(new Promise<void>((resolve, reject) => { control.onopen = () => resolve(); control.onerror = () => reject(new Error("scripted PC: relay refused")); }), "scripted PC control socket");
  const offer: RelayOffer = { v: 1, server_id: serverId, server_public_key: exportPublicKey(keys.publicKey), relay: RELAY, code: "123456", name };
  return { offer, serverId, stop: () => { for (const socket of sockets) socket.close(); } };
}

// ---- pages ----

let browser: Browser | undefined;
const csp: CspWatch[] = [];
const report: string[] = [];
const started = Date.now();
const note = (line: string): void => { report.push(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`); };

interface Seeded { server_id: string; server_public_key: string; name: string; device_id?: string }
/** Saved PCs, written as lib/relay/device.ts writes them, with a real non-extractable key. */
const seed = async (page: Page, entries: Seeded[]): Promise<void> => {
  await page.evaluate(async (entries) => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ovis-relay", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("devices", { keyPath: "server_id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("devices", "readwrite");
      for (const entry of entries) {
        tx.objectStore("devices").put({ ...entry, relay: "wss://relay.test", device_id: entry.device_id ?? "stale-device", private_key: keys.privateKey, public_spki: "spki", label: "QA phone" });
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, entries);
};
/** The saved record for a PC in this page's storage, or null. */
const saved = (page: Page, serverId: string): Promise<{ device_id: string | null } | null> => page.evaluate(async (serverId) => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("ovis-relay", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("devices", { keyPath: "server_id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<{ device_id: string | null } | null>((resolve, reject) => {
      const request = db.transaction("devices", "readonly").objectStore("devices").get(serverId);
      request.onsuccess = () => resolve(request.result ? { device_id: request.result.device_id ?? null } : null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}, serverId);

interface Opened { context: BrowserContext; page: Page; bridge: Bridge }
/** A fresh context and page: its own storage, its own relay bridge, the app's theme and language set. */
const open = async (options: { width?: number; height?: number; theme?: "dark" | "light"; clock?: boolean; mode?: Bridge["mode"] } = {}): Promise<Opened> => {
  if (!browser) throw new Error("no browser");
  const mobile = (options.width ?? 390) < 600;
  const context = await browser.newContext({ viewport: { width: options.width ?? 390, height: options.height ?? 844 }, colorScheme: options.theme ?? "dark", deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  const bridge = new Bridge();
  bridge.mode = options.mode ?? "carry";
  await bridgeRelay(context, bridge);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  if (options.clock) await page.clock.install();
  await page.addInitScript((theme) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme })), options.theme ?? "dark");
  csp.push(await watchCsp(page));
  return { context, page, bridge };
};
const state = (page: Page, name: string) => page.locator(`main[data-relay-state="${name}"]`);
const inApp = async (page: Page): Promise<void> => {
  await page.locator(".app").waitFor();
  assert.equal(await page.locator("main[data-relay-state]").count(), 0, "the shell's screen is gone once the app is up");
};
/** Opens a pairing offer, confirms it, and pairs; resolves once the connection attempt is under way. */
const pairFrom = async (page: Page, offer: RelayOffer): Promise<void> => {
  await page.goto(offerUrl(offer));
  await state(page, "confirm").waitFor();
  await page.getByRole("heading", { name: `Pair with ${offer.name ?? "this PC"}?` }).waitFor();
  assert.ok(!(await page.evaluate(() => location.href)).includes("#offer"), "the offer left the address before the question");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await state(page, "connecting").waitFor();
};

try {
  await startPcRelay();
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const identity = await serverOffer();
  const ID = identity.server_id;
  const scope = scopeOf(ID);

  // (a) nothing saved, no offer: the front page asks for the PC's QR code, both themes, both widths
  for (const [device, width, height] of [["mobile", 390, 844], ["desktop", 1440, 900]] as const) {
    for (const theme of ["light", "dark"] as const) {
      const { context, page } = await open({ width, height, theme });
      const response = await page.goto(`${origin}/`);
      assert.equal(response?.headers()["content-security-policy"], shellContentSecurityPolicy(), "the front page carries the shell policy");
      assert.equal(await page.evaluate(() => document.documentElement.dataset["theme"]), theme);
      await state(page, "empty").waitFor();
      await page.getByRole("heading", { name: "Scan the QR code on your PC" }).waitFor();
      assert.equal(await page.locator("main button").count(), 0, "the front page offers no Back");
      await shot(page, `empty-${device}-${theme}`);
      await context.close();
    }
  }
  note("empty: front page without a saved PC at 390 and 1440, light and dark");

  // (b) a damaged offer: the damaged screen, and not one request beyond this origin, not one socket
  {
    const { context, page, bridge } = await open();
    const requests: string[] = [];
    page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
    const before = `${scope}#offer=abc`;
    await page.goto(before);
    await state(page, "bad-offer").waitFor();
    await page.getByRole("heading", { name: "This pairing link is damaged" }).waitFor();
    const after = await page.evaluate(() => location.href);
    assert.equal(after, scope, "the fragment left the address bar");
    const foreign = requests.filter((line) => !line.includes(` ${origin}/`));
    assert.deepEqual(foreign, [], "every request stayed on the shell's origin");
    assert.deepEqual(bridge.sockets, [], "no relay socket for a damaged offer");
    await shot(page, "bad-offer");
    keep("task-16-bad-offer-requests.txt", `# every request the page made while showing the damaged-offer screen (${requests.length}); relay sockets: ${bridge.sockets.length}\n# origin: ${origin}\n${requests.join("\n")}\n`);
    keep("task-16-fragment.txt", `# the address before boot and after it\nbefore: ${before}\nafter:  ${after}\n`);
    note(`bad-offer: ${requests.length} requests, all on ${origin}; 0 relay sockets; address after boot ${after}`);
    await context.close();
  }

  // (c) connecting, then paired through the real relay to the real PC; then revoked on the PC while in the app
  {
    const { context, page, bridge } = await open({ mode: "hold" });
    const offer = await serverOffer();
    await page.goto(offerUrl(offer));
    await state(page, "confirm").waitFor();
    await shot(page, "confirm");
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await state(page, "connecting").waitFor();
    await page.getByRole("heading", { name: "Connecting to Desk PC…" }).waitFor();
    await shot(page, "connecting");
    const socket = await bounded(bridge.next(), "the shell's relay socket");
    assert.ok(socket.url.startsWith(`${RELAY}/v1/ws?server_id=${ID}&role=client&v=1`), socket.url);
    bridge.release.resolve();
    await bounded(socket.assigned, "the relay assigned the connection");
    await bounded(socket.pcAnswered, "the PC answered through the relay");
    await inApp(page);
    await until("the PC counts one relay session", () => service.status().sessions === 1);
    const paired = devices.list(null).filter((device) => device.via_relay);
    assert.equal(paired.length, 1, "the PC enrolled one relay device");
    assert.equal((await saved(page, ID))?.device_id, paired[0]!.id, "the phone saved the device id the PC gave it");
    await shot(page, "paired");
    note(`connecting -> paired: real Noise + mux through the relay; PC sessions=${service.status().sessions}; device ${paired[0]!.id} enrolled via relay`);
    // revoked on the PC: the session ends with auth_revoked, the app gives way to the screen, the key is gone
    devices.revoke(paired[0]!.id);
    await state(page, "revoked").waitFor();
    await page.getByRole("heading", { name: "This phone was removed from Desk PC" }).waitFor();
    assert.equal(await page.locator(".app").count(), 0, "the app is unmounted once the PC turned the phone away");
    assert.equal(await saved(page, ID), null, "the revoked phone forgot its key");
    assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0, "no retry on a revocation");
    await shot(page, "revoked");
    await page.goto(scope);
    await state(page, "empty").waitFor();
    note("revoked: devices.revoke on the PC -> auth_revoked -> app unmounted, key deleted, next visit asks for a QR code");
    await context.close();
  }

  // (d) PC offline: paired, the PC's relay turned off, the page reopened: the relay assigns, no PC answers, 15 s
  {
    const { context, page, bridge } = await open({ clock: true, theme: "light" });
    await pairFrom(page, await serverOffer());
    await inApp(page);
    await stopPcRelay();
    await page.goto(scope);
    await state(page, "connecting").waitFor();
    const socket = await bounded(bridge.next(), "the shell's relay socket");
    await bounded(socket.assigned, "the relay assigned the connection with the PC away");
    // the installed clock keeps ticking between calls, so the deadline is bracketed by a second, not a millisecond
    await page.clock.runFor(PC_ANSWER_MS - 1000);
    assert.equal(await state(page, "connecting").count(), 1, "still connecting a second before the PC's deadline");
    await page.clock.runFor(1100);
    await state(page, "pc-offline").waitFor();
    await page.getByRole("heading", { name: "Desk PC is offline" }).waitFor();
    assert.notEqual(await saved(page, ID), null, "an offline PC keeps the phone's key");
    await shot(page, "pc-offline");
    // the PC comes back: Try again reaches the app
    await startPcRelay();
    await page.getByRole("button", { name: "Try again" }).click();
    await state(page, "connecting").waitFor();
    await inApp(page);
    note(`pc-offline: relay up, PC relay stopped -> assigned, silence, pc-offline at ${PC_ANSWER_MS} ms; PC relay started again -> Try again -> app`);
    await context.close();
  }

  // (e) relay silent: accepted, never assigned, 10 s; relay stopped: refused at once; then the relay returns
  {
    const { context, page, bridge } = await open({ clock: true, mode: "silent" });
    await pairFrom(page, await serverOffer());
    await bounded(bridge.next(), "the shell's relay socket");
    await page.clock.runFor(ASSIGNMENT_MS - 1000);
    assert.equal(await state(page, "connecting").count(), 1, "still connecting a second before the relay's deadline");
    await page.clock.runFor(1100);
    await state(page, "relay-unreachable").waitFor();
    await page.getByRole("heading", { name: "The relay could not be reached" }).waitFor();
    assert.equal(await page.locator(".relay-shell-detail").count(), 0, "a silent relay has no close code to show");
    await shot(page, "relay-silent");
    note(`relay-unreachable (silent): socket accepted, nothing assigned -> relay-unreachable at ${ASSIGNMENT_MS} ms, not pc-offline`);
    await context.close();
  }
  {
    await relay!.stop();
    relay = null;
    const { context, page, bridge } = await open();
    const offer = await serverOffer();
    await pairFrom(page, offer);
    await state(page, "relay-unreachable").waitFor();
    await page.getByRole("heading", { name: "The relay could not be reached" }).waitFor();
    assert.equal(bridge.sockets.length, 1);
    await shot(page, "relay-unreachable");
    await restartRelay();
    await page.getByRole("button", { name: "Try again" }).click();
    await state(page, "connecting").waitFor();
    await inApp(page);
    assert.equal(bridge.sockets.length, 2, "Try again opened one more socket");
    note("relay-unreachable (stopped): connection refused -> relay-unreachable; relay restarted, PC reconnected, Try again -> app");
    await context.close();
  }

  // (f) code expired: the PC's pending code is past its lifetime when the phone presents it
  {
    const { context, page } = await open();
    const fresh = await serverOffer();
    const expired = devices.startPairing(Date.now() - 11 * 60_000).code;
    const enrolled = devices.list(null).length;
    await pairFrom(page, { ...fresh, code: expired });
    await state(page, "code-expired").waitFor();
    await page.getByRole("heading", { name: "That pairing code no longer works" }).waitFor();
    assert.equal(devices.list(null).length, enrolled, "an expired code enrolls nothing");
    assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0, "no retry on a dead code");
    await shot(page, "code-expired");
    note("code-expired: startPairing(now - 11 min) -> PAIR refused with auth_failed -> code-expired, nothing enrolled");
    await context.close();
  }

  // (g) identity changed: a saved key for this PC that is not the offer's; forgetting it pairs again
  {
    const { context, page, bridge } = await open({ theme: "light" });
    await page.goto(scope);
    await state(page, "empty").waitFor();
    await seed(page, [{ server_id: ID, server_public_key: "not-the-offer's-key", name: "Desk PC" }]);
    const offer = await serverOffer();
    await page.goto(offerUrl(offer));
    await state(page, "confirm").waitFor();
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await state(page, "identity-changed").waitFor();
    await page.getByRole("heading", { name: "Desk PC has a new identity" }).waitFor();
    assert.deepEqual(bridge.sockets, [], "a changed identity is refused before any socket opens");
    await shot(page, "identity-changed");
    await page.getByRole("button", { name: "Forget this PC" }).click();
    await state(page, "connecting").waitFor();
    await inApp(page);
    assert.equal(bridge.sockets.length, 1, "forgetting the PC pairs again over one socket");
    note("identity-changed: stale key refused with 0 sockets; Forget this PC -> paired again -> app");
    await context.close();
  }

  // (h) needs update: a PC that answers HELLO with unsupported_version
  {
    const pc = await scriptedPc("refuse", "Old PC");
    try {
      const { context, page } = await open();
      await pairFrom(page, pc.offer);
      await state(page, "needs-update").waitFor();
      await page.getByRole("heading", { name: "Update needed" }).waitFor();
      await shot(page, "needs-update");
      note("needs-update: SESSION_ERROR unsupported_version after a real handshake -> needs-update");
      await context.close();
    } finally { pc.stop(); }
  }

  // (i) PC unresponsive: a PC that completes the handshake and never answers HELLO, 10 s
  {
    const pc = await scriptedPc("stall", "Busy PC");
    try {
      const { context, page, bridge } = await open({ clock: true });
      await pairFrom(page, pc.offer);
      const socket = await bounded(bridge.next(), "the shell's relay socket");
      await bounded(socket.pcAnswered, "the scripted PC's handshake answer reached the page");
      await page.clock.runFor(ADMISSION_MS - 1000);
      assert.equal(await state(page, "connecting").count(), 1, "still connecting a second before the admission deadline");
      await page.clock.runFor(1100);
      await state(page, "pc-unresponsive").waitFor();
      await page.getByRole("heading", { name: "Busy PC did not finish connecting" }).waitFor();
      await shot(page, "pc-unresponsive");
      note(`pc-unresponsive: handshake answered, HELLO never -> pc-unresponsive at ${ADMISSION_MS} ms, not pc-offline`);
      await context.close();
    } finally { pc.stop(); }
  }

  // (j) saved PCs: the front page lists them; a row opens the PC's own scope, which connects by itself
  {
    const { context, page } = await open({ width: 1440, height: 900 });
    await page.goto(`${origin}/`);
    await state(page, "empty").waitFor();
    await seed(page, [{ server_id: ID, server_public_key: identity.server_public_key, name: "Desk PC" }, { server_id: OTHER_ID, server_public_key: identity.server_public_key, name: "Laptop" }]);
    await page.reload();
    await state(page, "list").waitFor();
    const rows = page.locator(".relay-shell-pc");
    assert.equal(await rows.count(), 2);
    assert.equal(await rows.nth(1).getAttribute("href"), `/s/${OTHER_ID}/`);
    await shot(page, "list");
    await rows.nth(1).click();
    await page.waitForURL(scopeOf(OTHER_ID));
    await state(page, "connecting").waitFor();
    note("list: two saved PCs listed; a row opens /s/<id>/, which starts connecting by itself");
    await context.close();
  }

  // (k) a PC's scope: its own worker, its own manifest, the shell policy and the worker rewrite
  {
    const { context, page } = await open();
    const response = await page.goto(scope);
    assert.equal(response?.headers()["content-security-policy"], shellContentSecurityPolicy());
    await state(page, "empty").waitFor();
    const facts = await page.evaluate(async (id) => {
      const registration = await navigator.serviceWorker.ready;
      const manifestLink = document.querySelector('link[rel="manifest"]') as HTMLLinkElement;
      const manifest = await (await fetch(manifestLink.href)).json() as Record<string, string>;
      const worker = await fetch(`/s/${id}/sw.js`);
      return {
        scope: new URL(registration.scope).pathname,
        script: new URL(registration.active?.scriptURL ?? registration.installing?.scriptURL ?? "").pathname,
        manifestHref: new URL(manifestLink.href).pathname,
        manifest: { id: manifest["id"], start_url: manifest["start_url"], scope: manifest["scope"] },
        workerType: worker.headers.get("content-type"),
        meta: document.querySelector('meta[name="ovis-shell"]')?.getAttribute("content") ?? null,
      };
    }, ID);
    assert.deepEqual(facts, {
      scope: `/s/${ID}/`, script: `/s/${ID}/sw.js`, manifestHref: `/s/${ID}/manifest.webmanifest`,
      manifest: { id: "./", start_url: "./", scope: "./" }, workerType: "text/javascript; charset=utf-8", meta: "relay",
    });
    keep("task-16-scope.txt", `# a PC's page in the hosted shell: what the browser registered and read\n${JSON.stringify(facts, null, 2)}\n`);
    note(`scope: worker ${facts.script} at ${facts.scope}; manifest ${facts.manifestHref} with id/start_url/scope ./`);
    await context.close();
  }

  assertCspClean(csp, "the hosted shell under the enforced shell policy");
  note(`csp: ${csp.length} watched pages, every one served the policy, no violation`);
  keep("task-16-states.txt", `# relay-shell-browser-qa: dist-shell at ${origin} (scripts/pages-static.ts), PC ${base} (createServer, relay ${RELAY} bridged to the Bun relay)\n${report.join("\n")}\n`);
  console.log(report.join("\n"));
} finally {
  await browser?.close();
  site.stop(true);
  await service.shutdown();
  app.stop();
  await relay?.stop();
  rmSync(stateDir, { recursive: true, force: true });
}
