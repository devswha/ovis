/**
 * The direct path for fleet machines (todo 29): while the fleet is in use (a machine in the store that is not revoked),
 * the controller's direct listener (server/relay/direct.ts) also listens on container and VM bridge adapters, and
 * names them with its other carriers in a machine's AUTH_OK only. A phone's AUTH_OK and lists stay as they were, a
 * device cannot sign in on a bridge address, nothing pairs there, and the gate in front refuses a browser's request
 * before any upgrade, on the new addresses too.
 *
 * The address choice is tested on injected interface lists; loopback aliases (127.0.0.2, 127.0.0.3) stand in for bridge
 * addresses where the listener itself is tested. The last block runs the built `ovis-link run` against the controller's
 * real direct listener on this PC's own addresses (OVIS_LINK_BIN names the binary: missing, a failure; else the
 * crate's release build: missing, skipped).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { connect, createServer as createTcpServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../../relay/bun.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import { openRelayChannel } from "../../shared/relay-channel.ts";
import type { RelayDevice, RelayDeviceStore } from "../../shared/relay-device.ts";
import { decodeFrame, DIRECT_CARRIER, isDirectCarrier, MuxProtocolError } from "../../shared/relay-mux.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { createServer } from "../index.ts";
import { DirectCarrier, rankLanAddresses } from "../relay/direct.ts";
import { loadRelayIdentity } from "../relay/identity.ts";
import { RelayService } from "../relay/service.ts";
import { bounded, deferred, relayConnection, relayDevice, TestClock } from "../relay/test-helpers.ts";
import { bridgeAddresses, fleetInUse, MAX_BRIDGE_ADDRESSES, MAX_MACHINE_CARRIERS, machineCarriers } from "./direct.ts";
import { machineFingerprint, pipeMuxExtension } from "./mux-ext.ts";
import type { MachineState, PipeStream } from "./mux-ext.ts";
import { Fleet } from "./sessions.ts";
import { FleetStore } from "./store.ts";
import { machineClient, machineConnection, machineKey, memoryDirectory, recordOf, testAdvert, testOwner, turnFleetOn } from "./test-helpers.ts";
import { FLEET_TEST_AUTH, FLEET_TEST_TOKEN, fleetTestServer } from "./test-server.ts";
import type { MachineKey } from "./test-helpers.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const nic = (address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false): NetworkInterfaceInfo => family === "IPv4"
  ? { address, netmask: "255.255.0.0", family, mac: "02:42:ac:11:00:01", internal, cidr: `${address}/16` }
  : { address, netmask: "ffff:ffff:ffff:ffff::", family, mac: "02:42:ac:11:00:01", internal, cidr: `${address}/64`, scopeid: 0 };

function stateFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-direct-"));
  chmodSync(dir, 0o700);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("bridge adapters", () => {
  it("are the container and VM bridges by name, at private IPv4 addresses only, never a public, shared or IPv6 one", () => {
    const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      lo: [nic("127.0.0.1", "IPv4", true), nic("::1", "IPv6", true)],
      eth0: [nic("192.168.0.10"), nic("2001:db8::10", "IPv6")],
      wlan0: [nic("10.1.1.5")],
      tailscale0: [nic("100.100.1.1")],
      wg0: [nic("10.6.0.1")],
      utun3: [nic("10.7.0.1")],
      docker0: [nic("172.17.0.1"), nic("fe80::42:acff:fe11:1", "IPv6"), nic("fd00:dead:beef::1", "IPv6")],
      "br-1a2b3c4d5e6f": [nic("172.18.0.1")],
      virbr0: [nic("192.168.122.1")],
      veth0a1b2c: [nic("169.254.10.1")],
      podman0: [nic("10.88.0.1")],
      lxcbr0: [nic("10.0.3.1")],
      lxdbr0: [nic("100.64.5.1")],
      vmnet8: [nic("192.0.2.1")],
      vboxnet0: [nic("198.51.100.1")],
      "br-public": [nic("203.0.113.5"), nic("8.8.8.8"), nic("2001:db8::1", "IPv6")],
      "br-zero": [nic("0.0.0.0")],
      "br-internal": [nic("172.30.0.1", "IPv4", true)],
      "vEthernet (WSL)": [nic("172.24.0.1")],
      bridge100: [nic("192.168.64.1")],
      vmnet1: [nic("172.16.5.1")],
    };
    // Windows' Hyper-V and WSL switches (vEthernet) are VM bridges by the `veth` name; macOS's bridge100 is not named
    expect(bridgeAddresses(interfaces)).toEqual(["172.17.0.1", "172.18.0.1", "192.168.122.1", "10.88.0.1", "10.0.3.1", "172.24.0.1", "172.16.5.1"]);
  });

  it("are at most MAX_BRIDGE_ADDRESSES, each once", () => {
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`br-${index}`, [nic(`172.${16 + (index % 16)}.${index}.1`)]]));
    many["docker0"] = [nic("172.16.0.1")];
    const found = bridgeAddresses(many);
    expect(found).toHaveLength(MAX_BRIDGE_ADDRESSES);
    expect(new Set(found).size).toBe(found.length);
  });
});

describe("the fleet in use", () => {
  it("means a machine in the store that is not revoked; an empty, all-revoked or refused store is not", async () => {
    const store = new FleetStore({ stateDir: stateFolder() });
    expect(fleetInUse(store)).toBe(false);
    const first = await machineKey();
    store.add({ machine_id: first.id, public_key: first.spki });
    expect(fleetInUse(store)).toBe(true);
    store.setState(first.id, "quarantined");
    expect(fleetInUse(store)).toBe(true);
    store.setState(first.id, "revoked");
    expect(fleetInUse(store)).toBe(false);
    const refused = stateFolder();
    mkdirSync(join(refused, "fleet"), { mode: 0o700 });
    writeFileSync(join(refused, "fleet", "machines.json"), "not json", { mode: 0o600 });
    expect(fleetInUse(new FleetStore({ stateDir: refused }))).toBe(false);
    // three synced store writes: on a loaded disk they can pass bun's 5 s default
  }, 30_000);
});

describe("the carriers a machine is told", () => {
  it("put the home network's first, a bridge and the Tailscale one before the rest, direct carriers only, at most four", () => {
    expect(machineCarriers({
      lan: ["ws://192.168.0.10:7319", "ws://10.1.1.5:7319"], tailnet: ["ws://100.101.102.103:7319"],
      bridges: ["ws://172.17.0.1:7319", "ws://172.18.0.1:7319", "ws://192.168.122.1:7319"],
    })).toEqual(["ws://192.168.0.10:7319", "ws://172.17.0.1:7319", "ws://100.101.102.103:7319", "ws://10.1.1.5:7319"]);
    expect(machineCarriers({ lan: [], tailnet: [], bridges: ["ws://172.17.0.1:7319", "ws://127.0.0.2:7319", "ws://8.8.8.8:7319", "ws://172.17.0.1:7319"] }))
      .toEqual(["ws://172.17.0.1:7319"]);
    expect(machineCarriers({ lan: [], tailnet: [], bridges: [] })).toEqual([]);
    expect(MAX_MACHINE_CARRIERS).toBe(4);
  });

  it("are read from a machine's AUTH_OK as auth.json says: 1..4 distinct private or Tailscale addresses, nothing else", () => {
    const vectors = JSON.parse(readFileSync(join(import.meta.dir, "vectors", "auth.json"), "utf8")) as { cases: { name: string; bytes: string; expect: { parse?: unknown; refuse?: unknown } }[] };
    const cases = vectors.cases.filter((entry) => entry.name === "auth/auth-ok/machine-with-direct" || entry.name.startsWith("auth/auth-ok/direct-"));
    expect(cases.length).toBe(7);
    for (const entry of cases) {
      const read = () => decodeFrame(Buffer.from(entry.bytes, "hex"), false, pipeMuxExtension);
      if (entry.expect.refuse) expect(read, entry.name).toThrow(MuxProtocolError);
      else expect((read() as { payload: unknown }).payload, entry.name).toEqual(entry.expect.parse);
    }
  });

  it("are named in a machine's AUTH_OK, never in a phone's, and left out when there are none", async () => {
    const fixture = fleetTestServer();
    cleanups.push(() => fixture.close());
    const key = await machineKey();
    const named = ["ws://192.168.0.10:7319", "ws://172.17.0.1:7319"];
    const machine = await machineConnection(fixture, memoryDirectory([recordOf(key)]), { machineCarriers: () => named });
    await machine.hello();
    expect(await machine.signIn(key)).toEqual({ session_id: expect.stringMatching(/^[0-9a-f]{32}$/), machine_id: key.id, role: "machine", direct: named });
    const bare = await machineConnection(fixture, memoryDirectory([recordOf(key)]), { machineCarriers: () => [] });
    await bare.hello();
    expect(await bare.signIn(key)).not.toHaveProperty("direct");
    const device = await relayDevice(fixture);
    const phone = await relayConnection(fixture, { directCarriers: () => ["ws://192.168.0.10:7319"], machineCarriers: () => named });
    expect((await phone.auth(device, [DIRECT_CARRIER])).direct).toEqual(["ws://192.168.0.10:7319"]);
  });
});

/** Whether this host can listen on a loopback alias (Linux can; macOS has 127.0.0.1 alone). */
function bindable(address: string): boolean {
  try { Bun.listen({ hostname: address, port: 0, socket: { data() {} } }).stop(true); return true; } catch { return false; }
}
const ALIASES = bindable("127.0.0.2") && bindable("127.0.0.3");

function reachable(address: string, port: number): Promise<boolean> {
  return bounded(new Promise((resolve) => {
    const socket = connect({ host: address, port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  }));
}

/** What the listener answers a raw request head, up to its close. */
function rawAnswer(address: string, port: number, head: string): Promise<string> {
  return bounded(new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: address, port });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    socket.once("connect", () => socket.write(head));
  }));
}
const upgradeHead = (extra = "") => `GET /v1/ws?v=1 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;

/** A phone's saved pairing, as the hosted app keeps it. */
function savedStore(device: Awaited<ReturnType<typeof relayDevice>>, offer: RelayOffer): RelayDeviceStore {
  const saved: RelayDevice = { server_id: offer.server_id, device_id: device.id, private_key: device.keys.privateKey,
    public_spki: device.publicKey, label: "Phone", server_public_key: offer.server_public_key, relay: offer.relay };
  return { get: async () => saved, update: async (_id, change) => change(saved), list: async () => [saved], remove: async () => {} };
}

/** A WebSocket to a carrier, as a Transport, once it said `assigned`. */
async function carrierTransport(url: string): Promise<Transport> {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const assigned = deferred<void>();
  const transport: Transport = { onmessage: null, onclose: null, onerror: null, send: (data) => { socket.send(data); }, close: (code, reason) => socket.close(code, reason) };
  socket.onmessage = (event) => {
    if (typeof event.data === "string" && event.data.includes('"assigned"')) { assigned.resolve(); return; }
    transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" });
  };
  socket.onclose = (event) => { assigned.reject(new Error(`closed ${event.code}`)); transport.onclose?.(event.code, event.reason); };
  cleanups.push(() => socket.close());
  await bounded(assigned.promise);
  return transport;
}

/** A controller's direct carrier: home address 127.0.0.1 (named to phones as 10.0.0.7), bridges on the aliases. */
async function bridged(options: { machines?: MachineState[]; clock?: TestClock; bridges?: string[] } = {}) {
  const fixture = fleetTestServer();
  cleanups.push(() => fixture.close());
  const store = new FleetStore({ stateDir: fixture.stateDir });
  const keys: MachineKey[] = [];
  for (const state of options.machines ?? []) {
    const key = await machineKey();
    store.add({ machine_id: key.id, public_key: key.spki });
    if (state !== "pending") store.setState(key.id, state);
    keys.push(key);
  }
  const fleet = new Fleet({ stateDir: fixture.stateDir, tokenConfigured: true, store, ...(options.clock ? { clock: options.clock } : {}) });
  fleet.start();
  cleanups.push(() => fleet.close());
  const bridges = options.bridges ?? ["127.0.0.2"];
  const home = ["127.0.0.1"];
  const identity = loadRelayIdentity(fixture.stateDir);
  const direct = new DirectCarrier({ identity, services: fixture.app.context.services, port: fixture.app.port,
    addresses: () => home, bridgeAddresses: () => bridges, preferredPort: 0, peerAllowed: () => true,
    advertise: (port) => [`ws://10.0.0.7:${port}`], fleet, ...(options.clock ? { clock: options.clock } : {}) });
  await direct.start();
  cleanups.push(() => direct.stop());
  const offer: RelayOffer = { v: 1, server_id: identity.server_id, server_public_key: identity.public_key, relay: "wss://relay.ovis.example" };
  const url = (address: string) => `ws://${address}:${direct.port}/v1/ws?v=1`;
  return { fixture, store, fleet, keys, bridges, home, direct, identity, offer, url };
}

describe.skipIf(!ALIASES)("the direct listener with the fleet in use", () => {
  it("listens on bridges only while a machine that is not revoked is in the store, following the store at once", async () => {
    const ctx = await bridged();
    const port = ctx.direct.port!;
    // not in use: exactly today's listeners
    expect(await reachable("127.0.0.1", port)).toBe(true);
    expect(await reachable("127.0.0.2", port)).toBe(false);
    const key = await machineKey();
    ctx.store.add({ machine_id: key.id, public_key: key.spki });
    expect(await reachable("127.0.0.2", port)).toBe(true);
    expect(ctx.direct.port).toBe(port);
    ctx.store.setState(key.id, "revoked");
    expect(await reachable("127.0.0.2", port)).toBe(false);
    expect(await reachable("127.0.0.1", port)).toBe(true);
    // a refused connection takes about 2 s on Windows (SYN retries): three such probes pass bun's 5 s default
  }, 30_000);

  it("closes the bridge listeners with the others when it stops", async () => {
    const ctx = await bridged({ machines: ["active"] });
    const port = ctx.direct.port!;
    expect(await reachable("127.0.0.2", port)).toBe(true);
    await ctx.direct.stop();
    expect(await reachable("127.0.0.2", port)).toBe(false);
    expect(await reachable("127.0.0.1", port)).toBe(false);
  }, 30_000);

  it("tells a phone exactly what it told it before, with the fleet on and off", async () => {
    const ctx = await bridged();
    const device = await relayDevice(ctx.fixture);
    const signIn = async () => {
      const channel = await bounded(openRelayChannel(ctx.offer, { store: savedStore(device, ctx.offer), socket: () => new WebSocket(ctx.url("127.0.0.1")), offerDirect: true, offerTailnet: true }));
      cleanups.push(() => channel.close());
      return JSON.stringify({ told: channel.directCarriers, listed: ctx.direct.advertised(true), lan: ctx.direct.advertised(false) });
    };
    const off = await signIn();
    const key = await machineKey();
    ctx.store.add({ machine_id: key.id, public_key: key.spki });
    expect(await reachable("127.0.0.2", ctx.direct.port!)).toBe(true);
    expect(await signIn()).toBe(off);
    expect(off).toBe(JSON.stringify({ told: [`ws://10.0.0.7:${ctx.direct.port}`], listed: [`ws://10.0.0.7:${ctx.direct.port}`], lan: [`ws://10.0.0.7:${ctx.direct.port}`] }));
  });

  it("refuses a device and a pairing code on a bridge address, and lets the same device in on its own", async () => {
    const ctx = await bridged({ machines: ["active"] });
    const device = await relayDevice(ctx.fixture);
    const refused = await bounded(openRelayChannel(ctx.offer, { store: savedStore(device, ctx.offer), socket: () => new WebSocket(ctx.url("127.0.0.2")) })).catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(MuxProtocolError);
    expect((refused as MuxProtocolError).code).toBe("auth_failed");
    const devices = ctx.fixture.app.context.services.devices;
    const code = devices.startPairing().code;
    const empty: RelayDeviceStore = { get: async () => undefined, update: async (_id, change) => change(undefined), list: async () => [], remove: async () => {} };
    const pairing = await bounded(openRelayChannel({ ...ctx.offer, code }, { store: empty, socket: () => new WebSocket(ctx.url("127.0.0.2")) })).catch((caught: unknown) => caught);
    expect((pairing as MuxProtocolError).code).toBe("auth_failed");
    const phone = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    expect(devices.pairRelay(code, "Phone", Buffer.from(await crypto.subtle.exportKey("spki", phone.publicKey)).toString("base64url"))).toBeTruthy();
    const home = await bounded(openRelayChannel(ctx.offer, { store: savedStore(device, ctx.offer), socket: () => new WebSocket(ctx.url("127.0.0.1")) }));
    cleanups.push(() => home.close());
    expect(home.device.device_id).toBe(device.id);
  });

  it("signs an enrolled machine in on a bridge address and refuses a key it does not hold, as the relay does", async () => {
    const ctx = await bridged({ machines: ["active"] });
    const machine = await machineClient(await carrierTransport(ctx.url("127.0.0.2")), ctx.identity.public_key, ctx.identity.server_id);
    await machine.signIn(ctx.keys[0]!);
    expect(await bounded(machine.admitted)).toMatchObject({ machine_id: ctx.keys[0]!.id, role: "machine" });
    expect(ctx.fleet.sessions).toBe(1);
    const stranger = await machineClient(await carrierTransport(ctx.url("127.0.0.2")), ctx.identity.public_key, ctx.identity.server_id);
    await stranger.signIn(await machineKey());
    expect(await bounded(stranger.error)).toEqual({ code: "auth_failed", message: "unknown" });
  });

  it("refuses any request that names an Origin before an upgrade, on a bridge address too", async () => {
    const ctx = await bridged({ machines: ["active"] });
    const port = ctx.direct.port!;
    for (const address of ["127.0.0.1", "127.0.0.2"]) {
      expect(await rawAnswer(address, port, upgradeHead("Origin: http://x\r\n"))).toStartWith("HTTP/1.1 403 ");
      expect(await rawAnswer(address, port, "GET / HTTP/1.1\r\nHost: x\r\nOrigin: http://x\r\n\r\n")).toStartWith("HTTP/1.1 404 ");
    }
    // the same upgrade without an Origin is let through
    const upgraded = await bounded(new Promise<string>((resolve) => {
      const socket = connect({ host: "127.0.0.2", port });
      socket.once("data", (chunk) => { resolve(chunk.toString("latin1")); socket.destroy(); });
      socket.once("connect", () => socket.write(upgradeHead()));
    }));
    expect(upgraded).toStartWith("HTTP/1.1 101 ");
  });

  it("bounds a flood from a bridge's peers as on every other address: connections, waiting places and their timeouts", async () => {
    const clock = new TestClock();
    const ctx = await bridged({ machines: ["active"], clock });
    const port = ctx.direct.port!;
    // eight connections from one peer that never finish a request: the ninth is closed unread, on either address
    const raw = (address: string): Promise<{ closed: Promise<void> }> => new Promise((resolve, reject) => {
      let done = (): void => {};
      const closed = new Promise<void>((settle) => { done = settle; });
      Bun.connect({ hostname: address, port, socket: { open: (socket) => { cleanups.push(() => socket.end()); resolve({ closed }); }, data() {}, close: () => done(), error: () => done() } }).catch(reject);
    });
    for (let index = 0; index < 8; index++) await raw("127.0.0.2");
    await bounded((await raw("127.0.0.2")).closed, 2_000);
    await bounded((await raw("127.0.0.1")).closed, 2_000);
  });

  it("holds two silent clients per peer on a bridge address, refuses a third within their grace, and closes them at the handshake deadline", async () => {
    const clock = new TestClock();
    const ctx = await bridged({ machines: ["active"], clock });
    const open = (socket: WebSocket) => bounded(new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("refused")); }));
    const first = new WebSocket(ctx.url("127.0.0.2"));
    const second = new WebSocket(ctx.url("127.0.0.2"));
    cleanups.push(() => first.close(), () => second.close());
    await open(first);
    await open(second);
    const third = new WebSocket(ctx.url("127.0.0.2"));
    cleanups.push(() => third.close());
    await expect(open(third)).rejects.toThrow();
    const closed = Promise.all([first, second].map((socket) => new Promise<void>((resolve) => { socket.onclose = () => resolve(); })));
    clock.advance(5_000);
    await bounded(closed);
  });

  /** Who listens where: the phones' addresses and the bridges', as the carrier holds them, and the sockets listening on `port`. */
  const listening = (direct: DirectCarrier, port: number) => {
    const inner = direct as unknown as { bound: { addresses: string[] } | null; bridges: Map<string, unknown> };
    const sockets = process.platform === "linux"
      ? Bun.spawnSync(["ss", "-Hltn", `sport = :${port}`]).stdout.toString().trim().split("\n").filter(Boolean).length : undefined;
    return { phones: [...inner.bound?.addresses ?? []], bridges: [...inner.bridges.keys()], sockets };
  };
  const signIn = async (ctx: Awaited<ReturnType<typeof bridged>>, device: Awaited<ReturnType<typeof relayDevice>>, address: string) =>
    bounded(openRelayChannel(ctx.offer, { store: savedStore(device, ctx.offer), socket: () => new WebSocket(ctx.url(address)) }))
      .then((channel) => { cleanups.push(() => channel.close()); return "admitted"; }, (error: unknown) => (error as MuxProtocolError).code);

  it("keeps the phones' port when a bridge address becomes a phone address, and serves it as a phone's", async () => {
    const clock = new TestClock();
    const ctx = await bridged({ machines: ["active"], clock });
    const port = ctx.direct.port!;
    const device = await relayDevice(ctx.fixture);
    expect(listening(ctx.direct, port)).toMatchObject({ phones: ["127.0.0.1"], bridges: ["127.0.0.2"] });
    expect(await signIn(ctx, device, "127.0.0.2")).toBe("auth_failed");
    // the default route moves onto the bridge-named adapter: its address joins the phones' list
    ctx.home.push("127.0.0.2");
    clock.advance(30_000);
    expect(ctx.direct.port).toBe(port);
    expect(listening(ctx.direct, port)).toMatchObject({ phones: ["127.0.0.1", "127.0.0.2"], bridges: [] });
    expect(ctx.direct.advertised(true)).toEqual([`ws://10.0.0.7:${port}`]);
    // served by the phones' gate now: a device signs in there as on any phone address, and a machine still does
    expect(await signIn(ctx, device, "127.0.0.2")).toBe("admitted");
    const machine = await machineClient(await carrierTransport(ctx.url("127.0.0.2")), ctx.identity.public_key, ctx.identity.server_id);
    await machine.signIn(ctx.keys[0]!);
    expect(await bounded(machine.admitted)).toMatchObject({ machine_id: ctx.keys[0]!.id });
  }, 30_000);

  it("keeps a machine's session and its open pipe on a bridge address when that address joins the phones' list", async () => {
    const clock = new TestClock();
    const ctx = await bridged({ machines: ["active"], clock });
    const taken = deferred<PipeStream>();
    const machine = await machineClient(await carrierTransport(ctx.url("127.0.0.2")), ctx.identity.public_key, ctx.identity.server_id, (pipe) => { pipe.accept(); taken.resolve(pipe); });
    await machine.signIn(ctx.keys[0]!);
    await bounded(machine.admitted);
    await machine.advertise(testAdvert(["bridge"]));
    const opened = await bounded(ctx.fleet.openPipe(ctx.keys[0]!.id, "bridge"));
    const far = await bounded(taken.promise);
    let reset = false;
    void opened.disposed.then(() => { reset = true; });
    // the default route moves onto the bridge-named adapter: its bridge listener goes, its connections stay
    ctx.home.push("127.0.0.2");
    clock.advance(30_000);
    expect(listening(ctx.direct, ctx.direct.port!)).toMatchObject({ phones: ["127.0.0.1", "127.0.0.2"], bridges: [] });
    await far.write(new TextEncoder().encode("still here"));
    const reader = opened.pipe.readable.getReader();
    const { value } = await bounded(reader.read());
    expect(new TextDecoder().decode(value)).toBe("still here");
    reader.releaseLock();
    expect(machine.mux.active).toBe(true);
    expect(ctx.fleet.online(ctx.keys[0]!.id)).toBe(true);
    expect(reset).toBe(false);
  }, 30_000);

  it("gives the address back to the bridges on the same port when it leaves the phones' list, and leaks no listener over many moves", async () => {
    const clock = new TestClock();
    const ctx = await bridged({ machines: ["active"], clock });
    const port = ctx.direct.port!;
    const device = await relayDevice(ctx.fixture);
    const before = listening(ctx.direct, port);
    for (let flip = 0; flip < 10; flip++) {
      ctx.home.push("127.0.0.2");
      clock.advance(30_000);
      expect(ctx.direct.port, `flip ${flip} in`).toBe(port);
      expect(listening(ctx.direct, port), `flip ${flip} in`).toEqual({ phones: ["127.0.0.1", "127.0.0.2"], bridges: [], sockets: before.sockets });
      expect(await reachable("127.0.0.2", port), `flip ${flip} in`).toBe(true);
      ctx.home.pop();
      clock.advance(30_000);
      expect(ctx.direct.port, `flip ${flip} out`).toBe(port);
      expect(listening(ctx.direct, port), `flip ${flip} out`).toEqual(before);
      expect(await reachable("127.0.0.2", port), `flip ${flip} out`).toBe(true);
    }
    // a bridge again: machines only
    expect(await signIn(ctx, device, "127.0.0.2")).toBe("auth_failed");
    expect(await signIn(ctx, device, "127.0.0.1")).toBe("admitted");
  }, 60_000);

  it("follows a bridge that appears or goes while running, on the same port, and keeps a carrier already open", async () => {
    const clock = new TestClock();
    const ctx = await bridged({ machines: ["active"], clock });
    const port = ctx.direct.port!;
    const machine = await machineClient(await carrierTransport(ctx.url("127.0.0.2")), ctx.identity.public_key, ctx.identity.server_id);
    await machine.signIn(ctx.keys[0]!);
    await bounded(machine.admitted);
    expect(await reachable("127.0.0.3", port)).toBe(false);
    // the adapter list changes: one goes, another appears; read again at the next refresh
    ctx.bridges.splice(0, ctx.bridges.length, "127.0.0.3");
    clock.advance(30_000);
    expect(await reachable("127.0.0.3", port)).toBe(true);
    expect(await reachable("127.0.0.2", port)).toBe(false);
    expect(ctx.direct.port).toBe(port);
    expect(machine.mux.active).toBe(true);
    expect(ctx.fleet.online(ctx.keys[0]!.id)).toBe(true);
    // its row names the route it came by
    expect(ctx.fleet.observe(ctx.keys[0]!.id).route).toBe("direct");
  }, 30_000);
});

const BUILD = join(import.meta.dir, "..", "..", "crates", "fleet-link", "target", "release", "ovis-link");
const BINARY = process.env["OVIS_LINK_BIN"] ?? BUILD;
const HOME_ADDRESSES = rankLanAddresses(networkInterfaces(), null);

/** Resolves once `read()` holds, looked at after each change in `dir`. */
async function until<T>(dir: string, read: () => T | undefined, ms = 30_000): Promise<T> {
  const result = deferred<T>();
  const look = () => { try { const value = read(); if (value !== undefined) result.resolve(value); } catch { /* mid-write */ } };
  const watcher = watch(dir, look);
  try { look(); return await bounded(result.promise, ms); } finally { watcher.close(); }
}

describe.skipIf((process.env["OVIS_LINK_BIN"] === undefined && !existsSync(BUILD)) || HOME_ADDRESSES.length === 0)("ovis-link run against the controller's real direct listener", () => {
  it("signs in through the relay, saves the carriers AUTH_OK names, then reaches the controller directly with the relay off", async () => {
    // Given a controller whose store holds this machine, on a local Bun relay, with its direct listener on this PC's own addresses
    const stateDir = stateFolder();
    const machine = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const scalar = Buffer.from((await crypto.subtle.exportKey("jwk", machine.privateKey)).d!, "base64url");
    const spki = Buffer.from(await crypto.subtle.exportKey("spki", machine.publicKey));
    const store = new FleetStore({ stateDir });
    const { machine_id: machineId } = store.add({ machine_id: machineFingerprint(spki), public_key: spki.toString("base64url"), name: "e2e" });
    store.setState(machineId, "active");
    const allow = { async limit() { return { success: true }; } };
    const relay = startBunRelay({ port: 0, hostname: "127.0.0.1", limits: { maxClientsPerServer: 12, maxSocketsPerAddress: 512 }, limiters: { perAddress: allow, global: allow } });
    let relayOn = true;
    cleanups.push(() => { if (relayOn) relay.stop(); });
    const service = new RelayService({
      stateDir, relay: "wss://relay.example", connect: (url) => new WebSocket(url.replace("wss://relay.example", `ws://127.0.0.1:${relay.port}`)),
      regionalRelays: [], ovisRelays: [], direct: { preferredPort: 0 },
    });
    const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: FLEET_TEST_TOKEN, tailscaleOwner: null, sidecar: false, relay: service });
    cleanups.push(async () => { await service.shutdown(); app.stop(); });
    const base = `http://127.0.0.1:${app.port}`;
    expect((await fetch(`${base}/api/relay/start`, { method: "POST", headers: { ...FLEET_TEST_AUTH, origin: base, "x-herdr-update": "1" } })).status).toBe(200);
    const direct = (service as unknown as { directCarrier: DirectCarrier; directStarting: Promise<void> });
    await bounded(direct.directStarting);
    const told = direct.directCarrier.machineCarriers();
    expect(told.length).toBeGreaterThan(0);
    for (const carrier of told) expect(isDirectCarrier(carrier)).toBe(true);
    // once for real: every bridge adapter this PC has (up to the cap) is listened on, a phone is told none of them
    const port = direct.directCarrier.port!;
    const bridges = bridgeAddresses(networkInterfaces());
    for (const address of bridges) expect(await reachable(address, port)).toBe(true);
    for (const carrier of direct.directCarrier.advertised(true)) expect(bridges.some((address) => carrier.includes(`//${address}:`))).toBe(false);

    // And the link agent with its machine key, a bridge stand-in, and a fleet.json naming the relay only
    const linkDir = stateFolder();
    const keyFile = join(linkDir, "machine.key");
    writeFileSync(keyFile, scalar, { mode: 0o600 });
    const echo = createTcpServer({ allowHalfOpen: true }, (socket) => { socket.on("error", () => {}); socket.pipe(socket); });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => echo.close());
    const fleetFile = join(linkDir, "fleet.json");
    const identity = loadRelayIdentity(stateDir);
    writeFileSync(fleetFile, JSON.stringify({ v: 1, controller: { server_id: identity.server_id, server_public_key: identity.public_key, relay: `ws://127.0.0.1:${relay.port}`, direct: [] }, owner: testOwner({ server_id: identity.server_id, server_public_key: identity.public_key }), machine_key_file: keyFile }), { mode: 0o600 });
    const bridgeToken = randomBytes(32).toString("hex");
    writeFileSync(join(linkDir, "advert.json"), JSON.stringify({ v: 1, runtime_id: "rt-e2e", boot_id: "boot-1", bridge_port: (echo.address() as { port: number }).port,
      bridge_token: bridgeToken, versions: { server: "0.5.0", agent: "0.5.0", runtime: "0.9.1" } }), { mode: 0o600 });
    const agent = Bun.spawn([BINARY, "run", "--state", linkDir], { stdout: "ignore", stderr: "pipe" });
    cleanups.push(async () => { agent.kill(); await agent.exited; });
    const status = (): { state: string; path?: string } => JSON.parse(readFileSync(join(linkDir, "status.json"), "utf8"));

    // When it signs in through the relay, it saves the carriers its AUTH_OK named, as they were named
    await until(linkDir, () => status().state === "connected" && status().path === "relay" ? true : undefined);
    const saved = await until(linkDir, () => {
      const file = JSON.parse(readFileSync(fleetFile, "utf8")) as { controller: { direct: string[]; relay: string; server_id: string }; machine_key_file: string };
      return file.controller.direct.length ? file : undefined;
    });
    expect(saved.controller.direct).toEqual([...told]);
    expect(saved.controller.relay).toBe(`ws://127.0.0.1:${relay.port}`);
    expect(saved.controller.server_id).toBe(identity.server_id);
    expect(saved.machine_key_file).toBe(keyFile);
    expect(statSync(fleetFile).mode & 0o777).toBe(0o600);

    // When the relay is switched off
    relay.stop();
    relayOn = false;
    // Then the agent comes back on a direct carrier, `ovis-link status --json` says so, and a pipe goes through a forward
    await until(linkDir, () => status().state === "connected" && status().path === "direct" ? true : undefined);
    const printed = Bun.spawnSync([BINARY, "status", "--state", linkDir, "--json"]);
    expect(printed.exitCode).toBe(0);
    expect(JSON.parse(printed.stdout.toString())).toMatchObject({ state: "connected", path: "direct", machine_id: machineId });
    const forward = await bounded(service.fleet.forwardReady(machineId));
    // the forward takes a connection only behind the bridge token in its first request head (server/fleet/forward.ts)
    const head = `GET / HTTP/1.1\r\nAuthorization: Bearer ${bridgeToken}\r\n\r\n`;
    const roundTrip = () => new Promise<string>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: forward!.port, allowHalfOpen: true });
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("error", () => {});
      socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
      socket.once("connect", () => socket.end(head + "through the direct carrier"));
    });
    // the advert follows AUTH_OK on the new session: a connection before it is closed empty, the next one goes through
    const reply = await bounded((async () => { for (;;) { const text = await roundTrip(); if (text) return text; } })(), 30_000);
    expect(reply).toBe(head + "through the direct carrier");
    expect(service.fleet.online(machineId)).toBe(true);
  }, 90_000);

  it("enrols with an invite the controller minted: ENROLL, then AUTH, the secret leaves fleet.json, pending until its batch is confirmed", async () => {
    // Given a controller with an empty store on a local Bun relay, with its direct listener on this PC's own addresses
    const stateDir = stateFolder();
    const allow = { async limit() { return { success: true }; } };
    const relay = startBunRelay({ port: 0, hostname: "127.0.0.1", limits: { maxClientsPerServer: 12, maxSocketsPerAddress: 512 }, limiters: { perAddress: allow, global: allow } });
    cleanups.push(() => relay.stop());
    const service = new RelayService({
      stateDir, relay: "wss://relay.example", connect: (url) => new WebSocket(url.replace("wss://relay.example", `ws://127.0.0.1:${relay.port}`)),
      regionalRelays: [], ovisRelays: [], direct: { preferredPort: 0 },
    });
    const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: FLEET_TEST_TOKEN, tailscaleOwner: null, sidecar: false, relay: service });
    cleanups.push(async () => { await service.shutdown(); app.stop(); });
    const base = `http://127.0.0.1:${app.port}`;
    const write = { ...FLEET_TEST_AUTH, origin: base, "x-herdr-update": "1", "content-type": "application/json" };
    expect((await fetch(`${base}/api/relay/start`, { method: "POST", headers: { ...FLEET_TEST_AUTH, origin: base, "x-herdr-update": "1" } })).status).toBe(200);
    await bounded((service as unknown as { directStarting: Promise<void> }).directStarting);
    // When the owner has turned the fleet on (`ovis-server fleet owner`) and mints an invite: its carriers are the ones a machine's AUTH_OK names
    turnFleetOn(stateDir);
    const minted = await fetch(`${base}/api/fleet/invites`, { method: "POST", headers: write, body: JSON.stringify({ count: 1, prefix: "e2e-" }) });
    expect(minted.status).toBe(201);
    const { batch_id: batchId, invites: [invite] } = (await minted.json()) as { batch_id: string; invites: { id: string; secret: string; controller: { server_id: string; server_public_key: string; relay: string; direct: string[] }; owner: unknown }[] };
    expect(invite!.controller.direct).toEqual([...(service as unknown as { directCarrier: DirectCarrier }).directCarrier.machineCarriers()]);
    // And the installer's fleet.json carries the invite (the relay as this test reaches it), a fresh machine key and an advert
    const linkDir = stateFolder();
    const machine = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const keyFile = join(linkDir, "machine.key");
    writeFileSync(keyFile, Buffer.from((await crypto.subtle.exportKey("jwk", machine.privateKey)).d!, "base64url"), { mode: 0o600 });
    const machineId = machineFingerprint(new Uint8Array(await crypto.subtle.exportKey("spki", machine.publicKey)));
    const fleetFile = join(linkDir, "fleet.json");
    writeFileSync(fleetFile, JSON.stringify({ v: 1, controller: { ...invite!.controller, relay: `ws://127.0.0.1:${relay.port}` }, owner: invite!.owner, machine_key_file: keyFile, invite: { id: invite!.id, secret: invite!.secret } }), { mode: 0o600 });
    const echo = createTcpServer({ allowHalfOpen: true }, (socket) => { socket.on("error", () => {}); socket.pipe(socket); });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => echo.close());
    const bridgeToken = randomBytes(32).toString("hex");
    writeFileSync(join(linkDir, "advert.json"), JSON.stringify({ v: 1, runtime_id: "rt-enrol", boot_id: "boot-1", bridge_port: (echo.address() as { port: number }).port,
      bridge_token: bridgeToken, versions: { server: "0.5.0", agent: "0.5.0", runtime: "0.9.1" } }), { mode: 0o600 });
    const agent = Bun.spawn([BINARY, "run", "--state", linkDir], { stdout: "ignore", stderr: "pipe" });
    cleanups.push(async () => { agent.kill(); await agent.exited; });
    const status = (): { state: string; machine_id?: string } => JSON.parse(readFileSync(join(linkDir, "status.json"), "utf8"));

    // Then it enrols and signs in pending (AUTH_OK says so), and the invite (its secret with it) leaves fleet.json, every other key kept
    await until(linkDir, () => status().state === "pending-confirmation" ? true : undefined);
    const saved = await until(linkDir, () => {
      const file = JSON.parse(readFileSync(fleetFile, "utf8")) as Record<string, unknown>;
      return "invite" in file ? undefined : file;
    });
    expect(saved).toMatchObject({ v: 1, machine_key_file: keyFile, controller: { server_id: invite!.controller.server_id }, owner: invite!.owner as object });
    expect(statSync(fleetFile).mode & 0o777).toBe(0o600);
    const raw = Buffer.from(invite!.secret, "base64url");
    for (const name of ["fleet.json", "status.json"]) {
      const text = readFileSync(join(linkDir, name), "latin1");
      for (const form of [raw.toString("latin1"), raw.toString("hex"), raw.toString("base64"), invite!.secret]) expect(text.includes(form), name).toBe(false);
    }
    const printed = Bun.spawnSync([BINARY, "status", "--state", linkDir, "--json"]);
    expect(JSON.parse(printed.stdout.toString())).toMatchObject({ state: "pending-confirmation", machine_id: machineId });
    // pending: listed, no forward, until the owner confirms its batch with the count and digest it was shown
    expect(service.fleet.store.get(machineId)).toMatchObject({ state: "pending", name: `e2e-${service.fleet.store.get(machineId)?.slot}` });
    expect(service.fleet.forward(machineId)).toBeUndefined();
    const { batches } = (await (await fetch(`${base}/api/fleet/batches`, { headers: FLEET_TEST_AUTH })).json()) as { batches: { batch_id: string; count: number; digest: string }[] };
    expect(batches.map((batch) => [batch.batch_id, batch.count])).toEqual([[batchId, 1]]);
    expect((await fetch(`${base}/api/fleet/batches/${batchId}/confirm`, { method: "POST", headers: write, body: JSON.stringify({ count: 1, digest: batches[0]!.digest }) })).status).toBe(200);
    // confirmed: the controller ends the pending session (GOAWAY) and the agent's next sign-in is not pending
    await until(linkDir, () => status().state === "connected" ? true : undefined);
    const forward = await bounded(service.fleet.forwardReady(machineId));
    const head = `GET / HTTP/1.1\r\nAuthorization: Bearer ${bridgeToken}\r\n\r\n`;
    const roundTrip = () => new Promise<string>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: forward!.port, allowHalfOpen: true });
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("error", () => {});
      socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
      socket.once("connect", () => socket.end(head + "enrolled"));
    });
    // its advert came on the session before the confirmation: the forward takes a connection once it listens
    const reply = await bounded((async () => { for (;;) { const text = await roundTrip(); if (text) return text; } })(), 30_000);
    expect(reply).toBe(head + "enrolled");
  }, 90_000);
});
