import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../relay/bun.ts";
import type { Machine } from "../shared/machines.ts";
import { GLOBAL_RELAY } from "../shared/relay-regions.ts";
import type { CompletionTracker } from "./completion.ts";
import { createServer } from "./index.ts";
import { bindTestPc, expectPcAddRefused, pcAddCases, type PcAddMode } from "./pc-add-policy.test-helpers.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { RelayService } from "./relay/service.ts";
import { bounded, deferred } from "./relay/test-helpers.ts";
import { TailnetPcError, TailnetPcs, tailnetPeers } from "./tailnet-pcs.ts";

const cleanup: (() => void | Promise<void>)[] = [];
const OWN_RELAY = "wss://relay.own.test";
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-tailnet-pcs-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function status(peers: { name: string; user: string; online?: boolean; tags?: string[]; os?: string }[]): string {
  const peer = Object.fromEntries(peers.map((p, index) => [`key${index}`, {
    HostName: `os-host-of-${p.name}`, DNSName: `${p.name}.tail.ts.net.`, UserID: p.user, Online: p.online ?? true, OS: p.os ?? "linux", ...(p.tags ? { Tags: p.tags } : {}),
  }]));
  // a real status writes user ids as bare numbers, some past 2^53
  return JSON.stringify({ BackendState: "Running", Self: { HostName: "pc-a", DNSName: "pc-a.tail.ts.net.", UserID: "USER1" }, Peer: peer })
    .replace(/"UserID":"(USER1|\d+)"/g, (_, id: string) => `"UserID":${id === "USER1" ? "9007199254740993" : id}`);
}

it("lists only online, untagged PCs of this PC's own Tailscale login, never phones", () => {
  const found = tailnetPeers(status([
    { name: "mine", user: "9007199254740993" },
    { name: "other-login", user: "9007199254740992" },
    { name: "tagged", user: "9007199254740993", tags: ["tag:server"] },
    { name: "asleep", user: "9007199254740993", online: false },
    { name: "phone", user: "9007199254740993", os: "iOS" },
  ]));
  expect(found).toEqual([{ name: "mine", dnsName: "mine.tail.ts.net", ips: [] }]);
  expect(tailnetPeers(null)).toEqual([]);
  expect(tailnetPeers(JSON.stringify({ BackendState: "Stopped" }))).toEqual([]);
});

/**
 * PC B with the relay on, reached as `tailscale serve` would bring a request from another node of the
 * tailnet: from loopback, with the asking node's login and its tailnet source address.
 */
async function pcB(login: string, options: { codeServerId?: string; mode?: PcAddMode; ownRelay?: boolean; codeRelay?: string } = {}) {
  const relay = startBunRelay({ port: 0, limiters: {
    perAddress: { async limit() { return { success: true }; } },
    global: { async limit() { return { success: true }; } },
  } });
  cleanup.push(() => relay.stop());
  const synced = deferred<void>();
  const local = (url: string): WebSocket => {
    const target = new URL(url);
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
    if (target.searchParams.get("role") === "server" && !target.searchParams.has("connection_id")) {
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string" && JSON.parse(event.data).type === "sync") synced.resolve();
      });
    }
    return socket;
  };
  const bState = stateDir();
  if (options.mode === "target-bound") bindTestPc(bState);
  // on a relay of its own beside an app of its own, it holds its codes on that relay
  const service = options.ownRelay
    ? new RelayService({ stateDir: bState, relay: OWN_RELAY, app: "https://app.own.test", connect: local })
    : new RelayService({ stateDir: bState, relay: `wss://127.0.0.1:${relay.port}`, connect: local, pairCodeRelay: GLOBAL_RELAY });
  const b = createServer({ port: 0, hostname: "127.0.0.1", stateDir: bState, token: "", tailscaleOwner: "me@example.com", sidecar: false, registerBridge: false, relay: service,
    accountOpensAll: options.mode !== undefined && options.mode !== "off", platform: "linux" });
  cleanup.push(async () => { await service.shutdown(); b.stop(); });
  const bBase = `http://127.0.0.1:${b.port}`;
  expect((await fetch(`${bBase}/api/relay/start`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } })).status).toBe(200);
  await bounded(synced.promise);
  const asked: string[] = [];
  const serve = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    asked.push(`${request.method} ${url.pathname}`);
    const headers = new Headers(request.headers);
    headers.set("tailscale-user-login", login);
    headers.set("x-forwarded-for", "100.64.0.7");
    const answer = await fetch(`${bBase}${url.pathname}${url.search}`, { method: request.method, headers, body: request.body });
    // a PC that names another PC's ID beside its code
    if (url.pathname === "/api/relay/code" && options.codeServerId !== undefined) return Response.json({ ...await answer.json() as object, server_id: options.codeServerId });
    // a PC that names a relay no PC would hold a code on
    if (url.pathname === "/api/relay/code" && options.codeRelay !== undefined) return Response.json({ ...await answer.json() as object, relay: options.codeRelay });
    return answer;
  } });
  cleanup.push(() => serve.stop(true));
  return { b, bBase, serveUrl: `http://127.0.0.1:${serve.port}`, local, asked };
}

async function pcA(initial: Parameters<typeof status>[0], origins: Record<string, string>, local: (url: string) => WebSocket, mode?: PcAddMode) {
  const probed: string[] = [];
  let peers = initial;
  const dir = stateDir();
  if (mode === "source-bound") bindTestPc(dir);
  const a = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false, relayPcSocket: local,
    ...(mode ? { accountOpensAll: mode !== "off", platform: "linux" as const } : {}),
    tailnetPcs: { readStatus: async () => status(peers), ports: [443], origin: (dnsName) => { probed.push(dnsName); return origins[dnsName] ?? "http://127.0.0.1:9"; },
      resolveHost: async () => ["203.0.113.7"] } });
  cleanup.push(() => a.stop());
  const base = `http://127.0.0.1:${a.port}`;
  const ask = (method: string, body?: unknown) => fetch(`${base}/api/machines/tailnet`, {
    method, headers: { origin: base, "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ask, probed, base, setPeers: (next: Parameters<typeof status>[0]) => { peers = next; } };
}

type Found = { pcs: { name: string; url: string; relay: string | null; outdated: boolean; server_id: string | null }[] };

it.each(pcAddCases)("Tailnet one-tap PC add follows the live account binding: %s", async mode => {
  const { b, serveUrl, local } = await pcB("me@example.com", { mode });
  const { ask, probed } = await pcA([{ name: "pc-b", user: "9007199254740993" }, { name: "stranger", user: "42" }], { "pc-b.tail.ts.net": serveUrl }, local, mode);

  const listed = await ask("GET");
  expect(listed.status).toBe(200);
  const { pcs } = await listed.json() as Found;
  const listedB = { name: "pc-b", url: serveUrl, relay: "online", outdated: false, server_id: b.context.services.relay.serverId() ?? null };
  expect(listedB.server_id).toEqual(expect.any(String));
  expect(pcs).toEqual([listedB]);
  // a node of another login is never asked anything
  expect(probed).toEqual(["pc-b.tail.ts.net"]);
  if (mode === "source-bound") return expectPcAddRefused(await ask("POST", { url: serveUrl }), mode, b);

  // only an address the list found is asked for a code
  expect((await ask("POST", { url: "http://127.0.0.1:9" })).status).toBe(404);

  const added = await ask("POST", { url: serveUrl });
  if (mode === "target-bound") return expectPcAddRefused(added, mode, b);
  expect(added.status).toBe(201);
  const { machine } = await added.json() as { machine: Machine };
  expect(machine).toMatchObject({ kind: "relay", name: "pc-b", relay: { server_id: b.context.services.relay.serverId() } });
  // still listed once added: the page tells it apart by its relay ID, and a second add is refused
  expect(await (await ask("GET")).json()).toEqual({ pcs: [listedB] });
  expect(((await (await ask("POST", { url: serveUrl })).json()) as { error: { code: string } }).error.code).toBe("tailnet_already_added");
});

it("adds a PC on a relay of its own by looking its code up on that relay", async () => {
  const { b, serveUrl, local } = await pcB("me@example.com", { ownRelay: true });
  const reached: string[] = [];
  const { ask } = await pcA([{ name: "pc-b", user: "9007199254740993" }], { "pc-b.tail.ts.net": serveUrl }, (url) => { reached.push(new URL(url).origin); return local(url); });
  await ask("GET");
  const added = await ask("POST", { url: serveUrl });
  expect(added.status).toBe(201);
  expect((await added.json() as { machine: Machine }).machine).toMatchObject({ kind: "relay", relay: { server_id: b.context.services.relay.serverId() } });
  expect(reached[0]).toBe(OWN_RELAY);
});

it("looks a code up on Ovis's relay when the PC names a relay that is not a wss origin", async () => {
  const { serveUrl, local } = await pcB("me@example.com", { ownRelay: true, codeRelay: `${OWN_RELAY}/elsewhere` });
  const reached: string[] = [];
  const { ask } = await pcA([{ name: "pc-b", user: "9007199254740993" }], { "pc-b.tail.ts.net": serveUrl }, (url) => { reached.push(new URL(url).origin); return local(url); });
  await ask("GET");
  await ask("POST", { url: serveUrl });
  expect(reached[0]).toBe(GLOBAL_RELAY);
});

it("adds nothing when the relay finds another PC than the one that gave the code", async () => {
  const { serveUrl, local } = await pcB("me@example.com", { codeServerId: "f".repeat(43) });
  const { ask, base } = await pcA([{ name: "pc-b", user: "9007199254740993" }], { "pc-b.tail.ts.net": serveUrl }, local);
  await ask("GET");
  const added = await ask("POST", { url: serveUrl });
  expect(added.status).toBe(409);
  expect((await added.json() as { error: { code: string } }).error.code).toBe("tailnet_mismatch");
  const { machines } = await (await fetch(`${base}/api/machines`, { headers: { origin: base } })).json() as { machines: Machine[] };
  expect(machines.filter((machine) => machine.kind === "relay")).toEqual([]);
});

it("asks no code of a PC whose relay is off", async () => {
  const { bBase, serveUrl, local, asked } = await pcB("me@example.com");
  expect((await fetch(`${bBase}/api/relay/stop`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } })).status).toBe(200);
  const { ask } = await pcA([{ name: "pc-b", user: "9007199254740993" }], { "pc-b.tail.ts.net": serveUrl }, local);
  expect((await (await ask("GET")).json() as Found).pcs).toEqual([{ name: "pc-b", url: serveUrl, relay: "off", outdated: false, server_id: expect.any(String) }]);
  const added = await ask("POST", { url: serveUrl });
  expect((await added.json() as { error: { code: string } }).error.code).toBe("tailnet_relay_off");
  expect(asked).not.toContain("POST /api/relay/code");
});

it("tells a watching device nothing and asks no PC", async () => {
  let asked = 0;
  const manager = new MachineManager(stateDir(), {} as PushService, {} as CompletionTracker, async () => { throw new Error("local offline"); },
    { tailnet: { readStatus: async () => { asked++; return status([{ name: "pc-b", user: "9007199254740993" }]); } } });
  const response = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/tailnet"), manager, undefined, undefined, true);
  expect(response.status).toBe(403);
  expect(asked).toBe(0);
  manager.stop();
});

it("lets no open LAN window borrow this PC's Tailscale login, and adds no PC that has since left it", async () => {
  const { serveUrl, local } = await pcB("me@example.com");
  const { ask, base, setPeers } = await pcA([{ name: "pc-b", user: "9007199254740993" }], { "pc-b.tail.ts.net": serveUrl }, local);
  const fromLan = await fetch(`${base}/api/machines/tailnet`, { headers: { origin: base, "x-forwarded-for": "192.168.1.5" } });
  expect(fromLan.status).toBe(403);
  expect((await fromLan.json() as { error: { code: string } }).error.code).toBe("owner_only");

  expect((await (await ask("GET")).json() as Found).pcs).toHaveLength(1);
  // Tailscale now says that name is another login's: the list minutes ago does not make it addable
  setPeers([{ name: "pc-b", user: "42" }]);
  const added = await ask("POST", { url: serveUrl });
  expect(added.status).toBe(404);
  expect((await added.json() as { error: { code: string } }).error.code).toBe("tailnet_not_found");
});

it("stops reading a PC's answer past its size bound", async () => {
  const big = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(JSON.stringify({ ok: true, auth: { authenticated: true, via: "tailscale", role: "drive" }, pad: "x".repeat(200_000) })) });
  cleanup.push(() => big.stop(true));
  const { ask } = await pcA([{ name: "pc-b", user: "9007199254740993" }], { "pc-b.tail.ts.net": `http://127.0.0.1:${big.port}` }, (url) => new WebSocket(url));
  expect(await (await ask("GET")).json()).toEqual({ pcs: [] });
});

it("does not list a PC that does not let this PC's login drive it", async () => {
  const { serveUrl, local } = await pcB("them@example.com");
  const { ask } = await pcA([{ name: "pc-b", user: "9007199254740993" }], { "pc-b.tail.ts.net": serveUrl }, local);
  expect(await (await ask("GET")).json()).toEqual({ pcs: [] });
  expect((await ask("POST", { url: serveUrl })).status).toBe(404);
});

/**
 * A PC whose Ovis predates typed codes (0.4.22 and before), answering as that release does: its health names no
 * relay ID, and it refuses `POST /api/relay/code` as an unknown relay action.
 */
function olderOvis(options: { serverId?: unknown; phase?: string; refusal?: { status: number; code: string }; code?: object } = {}) {
  const asked: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const { pathname } = new URL(request.url);
    asked.push(`${request.method} ${pathname}`);
    if (pathname === "/api/health") return Response.json({ ok: true, auth: { required: false, authenticated: true, via: "tailscale", role: "drive" },
      relay: { phase: options.phase ?? "online", relay: "wss://relay.example", app: "https://app.ovis.sh", sessions: 0, blocked: null, error: null },
      web_ui: { boot_id: "b", revision: null, ...(options.serverId ? { server_id: options.serverId } : {}) } });
    // a current Ovis, or one that answers its code request as it likes
    if (pathname === "/api/relay/code" && options.code !== undefined) return Response.json(options.code);
    const refusal = options.refusal ?? { status: 405, code: "method_not_allowed" };
    return Response.json({ error: { code: refusal.code, message: "Unknown relay action." } }, { status: refusal.status });
  } });
  cleanup.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, asked };
}

const onePeer = async () => status([{ name: "pc-b", user: "9007199254740993" }]);

it("lists a PC with an older Ovis as one to update, and asks it for no code", async () => {
  const old = olderOvis();
  const pcs = new TailnetPcs({ readStatus: onePeer, ports: [443], origin: () => old.url });
  expect(await pcs.list()).toEqual([{ name: "pc-b", url: old.url, relay: "online", outdated: true, server_id: null }]);
  const failure = await pcs.code(old.url, new Set()).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(TailnetPcError);
  expect((failure as TailnetPcError).failure).toBe("outdated");
  expect(old.asked).not.toContain("POST /api/relay/code");
});

it("lists the current Ovis of a PC that also runs an older one on another port", async () => {
  const old = olderOvis();
  const current = olderOvis({ serverId: "a".repeat(32) });
  const pcs = new TailnetPcs({ readStatus: onePeer, ports: [443, 8443], origin: (_dnsName, port) => port === 443 ? old.url : current.url });
  expect(await pcs.list()).toEqual([{ name: "pc-b", url: current.url, relay: "online", outdated: false, server_id: "a".repeat(32) }]);
});

it("passes on only a relay ID shaped as one, whatever that PC's health sends", async () => {
  for (const serverId of [42, "A".repeat(32), "a".repeat(43), "../x", { id: "a".repeat(32) }]) {
    const odd = olderOvis({ serverId });
    const pcs = new TailnetPcs({ readStatus: onePeer, ports: [443], origin: () => odd.url });
    expect((await pcs.list()).map((pc) => pc.server_id)).toEqual([null]);
  }
});

it("lists an Ovis whose relay is off, which may be a current one, over an older one", async () => {
  const older = olderOvis();
  const relayOff = olderOvis({ phase: "off" });
  const pcs = new TailnetPcs({ readStatus: onePeer, ports: [443, 8443], origin: (_dnsName, port) => port === 443 ? older.url : relayOff.url });
  expect(await pcs.list()).toEqual([{ name: "pc-b", url: relayOff.url, relay: "off", outdated: false, server_id: null }]);
});

async function codeOf(code: object, resolveHost?: (host: string) => Promise<string[]>) {
  const pc = olderOvis({ serverId: "a".repeat(32), code: { code: "7-ABCD-EFGH", ...code } });
  const pcs = new TailnetPcs({ readStatus: onePeer, ports: [443], origin: () => pc.url, resolveMs: 50, ...(resolveHost ? { resolveHost } : {}) });
  await pcs.list();
  return await pcs.code(pc.url, new Set()).catch((error: unknown) => error);
}

it("refuses a code beside another relay ID than the one that PC's health named", async () => {
  const failure = await codeOf({ server_id: "b".repeat(32), relay: "wss://relay.elsewhere.test" }, async () => ["203.0.113.7"]);
  expect(failure).toBeInstanceOf(TailnetPcError);
  expect((failure as TailnetPcError).failure).toBe("mismatch");
});

it("looks a code up only on one of Ovis's relays or a relay at a public address", async () => {
  const resolved: string[] = [];
  const dns: Record<string, string[]> = { "relay.own.test": ["203.0.113.7", "2001:db8::7"], "inside.test": ["203.0.113.7", "10.0.0.5"], "loop.test": ["127.0.0.1"], "mapped.test": ["::ffff:127.0.0.1"] };
  const resolveHost = async (host: string) => {
    resolved.push(host);
    // a resolver that never answers
    if (host === "stalled.test") return await new Promise<string[]>(() => {});
    const found = dns[host];
    if (!found) throw new Error("ENOTFOUND");
    return found;
  };
  expect(await codeOf({ server_id: "a".repeat(32), relay: GLOBAL_RELAY }, resolveHost)).toEqual({ code: "7-ABCD-EFGH", server_id: "a".repeat(32), relay: GLOBAL_RELAY });
  expect(resolved).toEqual([]);
  expect(await codeOf({ server_id: "a".repeat(32), relay: "wss://relay.own.test:8443" }, resolveHost)).toEqual({ code: "7-ABCD-EFGH", server_id: "a".repeat(32), relay: "wss://relay.own.test:8443" });
  for (const relay of ["wss://127.0.0.1:8443", "wss://10.0.0.5", "wss://192.168.1.2", "wss://169.254.169.254", "wss://100.100.100.100", "wss://[::1]", "wss://[fe80::1]", "wss://[fd7a:115c:a1e0::1]",
    "wss://[::ffff:7f00:1]", "wss://[::7f00:1]", "wss://192.0.0.1", "wss://198.18.0.1", "wss://[fec0::1]",
    "wss://inside.test", "wss://loop.test", "wss://mapped.test", "wss://nowhere.test", "wss://stalled.test"]) {
    const failure = await codeOf({ server_id: "a".repeat(32), relay }, resolveHost);
    expect([relay, (failure as TailnetPcError).failure]).toEqual([relay, "code_unavailable"]);
  }
});

it("tells each refusal of the code request in its own failure, never with that PC's own words", async () => {
  const cases: [{ status: number; code: string }, string][] = [
    [{ status: 405, code: "method_not_allowed" }, "no_code"],
    [{ status: 404, code: "not_found" }, "no_code"],
    [{ status: 409, code: "relay_off" }, "relay_off"],
    [{ status: 409, code: "relay_offline" }, "relay_offline"],
    [{ status: 409, code: "code_unavailable" }, "code_unavailable"],
    [{ status: 500, code: "internal" }, "no_code"],
  ];
  for (const [refusal, expected] of cases) {
    const refusing = olderOvis({ serverId: "a".repeat(32), refusal });
    const pcs = new TailnetPcs({ readStatus: onePeer, ports: [443], origin: () => refusing.url });
    await pcs.list();
    const failure = await pcs.code(refusing.url, new Set()).catch((error: unknown) => error) as TailnetPcError;
    expect([refusal.code, failure.failure]).toEqual([refusal.code, expected]);
    expect(failure.message).not.toContain("Unknown relay action");
    if (expected === "code_unavailable") expect(failure.message).toContain("without an app of its own");
  }
});
