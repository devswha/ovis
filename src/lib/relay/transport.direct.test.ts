import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../../../relay/bun.ts";
import { createServer } from "../../../server/index.ts";
import { RelayService } from "../../../server/relay/service.ts";
import { bounded, deferred } from "../../../server/relay/test-helpers.ts";
import { openRelayChannel } from "./channel.ts";
import { DirectCarrierUnusableError, probeDirect } from "../../../shared/relay-channel.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import type { RelayChannel, RelayChannelOptions } from "./channel.ts";
import type { RelayDevice, RelayDeviceStore } from "../../../shared/relay-device.ts";
import { MuxProtocolError } from "../../../shared/relay-mux.ts";
import { decodeOffer } from "../../../shared/relay-offer.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { openRelayTransport } from "./transport.ts";
import type { RelayTransport } from "./transport.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

/** The address the PC names in AUTH_OK; the phone's socket reaches it on loopback, where the test listens. */
const LAN = "10.0.0.7";

class MemoryStore implements RelayDeviceStore {
  saved: RelayDevice | undefined;
  async get() { return this.saved; }
  async update(_id: string, change: (current: RelayDevice | undefined) => RelayDevice) { return (this.saved = change(this.saved)); }
  async list() { return this.saved ? [this.saved] : []; }
  async remove() { this.saved = undefined; }
}

/** A PC on a local relay with direct connections on, and a phone's way to both. */
async function pcFixture() {
  const relay = startBunRelay({ port: 0 });
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-direct-transport-"));
  const synced = deferred<void>();
  const toRelay = (url: string): WebSocket => {
    const target = new URL(url);
    return new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
  };
  const service = new RelayService({
    stateDir, relay: "wss://relay.test",
    connect: (url) => {
      const socket = toRelay(url);
      socket.addEventListener("message", (event) => { if (typeof event.data === "string" && JSON.parse(event.data).type === "sync") synced.resolve(); });
      return socket;
    },
    direct: { addresses: () => ["127.0.0.1"], peerAllowed: () => true, preferredPort: 0, advertise: (port) => [`ws://${LAN}:${port}`] },
  });
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, relay: service });
  cleanup.push(() => relay.stop(), () => rmSync(stateDir, { recursive: true, force: true }), async () => { await service.shutdown(); app.stop(); });
  const base = `http://127.0.0.1:${app.port}`;
  await fetch(`${base}/api/relay/start`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
  await bounded(synced.promise);
  const offer = decodeOffer(((await (await fetch(`${base}/api/relay/offer`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } })).json()) as { url: string }).url)!;
  const direct: string[] = [];
  const directSocket = (url: string): WebSocket => {
    direct.push(url);
    return new WebSocket(url.replace(`ws://${LAN}:`, "ws://127.0.0.1:"));
  };
  /** every channel the phone's transport opened, in order */
  const channels: RelayChannel[] = [];
  const next: ((channel: RelayChannel) => void)[] = [];
  const openChannel = async (channelOffer: RelayOffer, options?: RelayChannelOptions): Promise<RelayChannel> => {
    const channel = await openRelayChannel(channelOffer, { ...options, ...(options?.direct === undefined ? { socket: toRelay } : {}) });
    channels.push(channel);
    next.shift()?.(channel);
    return channel;
  };
  const opened = (): Promise<RelayChannel> => bounded(new Promise((resolve) => next.push(resolve)));
  return { app, service, offer, direct, directSocket, channels, openChannel, opened };
}

async function transportFor(pc: Awaited<ReturnType<typeof pcFixture>>, store: MemoryStore, offer: RelayOffer, extra: Partial<Parameters<typeof openRelayTransport>[1]> = {}): Promise<RelayTransport> {
  const transport = await openRelayTransport(offer, { store, openChannel: pc.openChannel, directSocket: pc.directSocket, ...extra });
  cleanup.push(() => transport.close());
  return transport;
}

describe("direct carriers in the relay transport", () => {
  it("pairs through the relay, then moves to the PC's direct carrier on its own", async () => {
    // Given a phone pairing with the code from the PC's QR code
    const pc = await pcFixture();
    const store = new MemoryStore();
    const moved = pc.opened().then(() => pc.opened());
    // When it opens the PC
    const transport = await transportFor(pc, store, pc.offer);
    // Then the pairing went through the relay, and the PC named its direct carrier
    expect(pc.channels[0]!.direct).toBeUndefined();
    expect(store.saved?.direct).toEqual([`ws://${LAN}:${pc.service.status().direct!.carriers[0]!.split(":").at(-1)}`]);
    // and once idle it came back on that carrier, as itself
    const direct = await moved;
    expect(direct.direct).toBe(store.saved!.direct![0]);
    expect(direct.device.device_id).toBe(pc.channels[0]!.device.device_id);
    expect(transport.route).toBe("direct");
  });

  it("opens directly first next time, without the relay", async () => {
    // Given a phone that paired and was told the PC's direct carrier
    const pc = await pcFixture();
    const store = new MemoryStore();
    const first = await transportFor(pc, store, pc.offer);
    first.close();
    const { code: _code, ...saved } = pc.offer;
    // When it opens the PC again
    const before = pc.channels.length;
    const transport = await transportFor(pc, store, saved);
    // Then its first channel is the direct one
    expect(pc.channels[before]!.direct).toBe(store.saved!.direct![0]);
    expect(transport.route).toBe("direct");
  });

  it("goes through the relay when the direct carrier does not answer", async () => {
    // Given a phone whose saved direct carrier leads nowhere (it left the PC's network)
    const pc = await pcFixture();
    const store = new MemoryStore();
    (await transportFor(pc, store, pc.offer)).close();
    const { code: _code, ...saved } = pc.offer;
    // When it opens the PC and the direct socket fails
    const transport = await transportFor(pc, store, saved, { directSocket: () => new WebSocket("ws://127.0.0.1:1/v1/ws?v=1") });
    // Then it is up through the relay
    expect(transport.route).toBe("relay");
  });

  it("stays refused when the PC removed the device, rather than falling back", async () => {
    // Given a phone the PC removed after it was told the direct carrier
    const pc = await pcFixture();
    const store = new MemoryStore();
    (await transportFor(pc, store, pc.offer)).close();
    pc.app.context.services.devices.revoke(store.saved!.device_id!);
    const { code: _code, ...saved } = pc.offer;
    // When it opens the PC again, the PC's refusal on the direct carrier is final
    const error = await openRelayTransport(saved, { store, openChannel: pc.openChannel, directSocket: pc.directSocket }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MuxProtocolError);
    expect((error as MuxProtocolError).code).toBe("auth_failed");
    expect(pc.channels.every((channel) => channel.direct === undefined)).toBe(true);
  });

  it("never opens a direct carrier without the app's socket for it", async () => {
    // Given a page with no way to open one (a browser)
    const pc = await pcFixture();
    const store = new MemoryStore();
    // When it opens the PC
    const transport = await openRelayTransport(pc.offer, { store, openChannel: pc.openChannel });
    cleanup.push(() => transport.close());
    // Then it asked for no carriers and keeps the relay
    expect(store.saved?.direct).toBeUndefined();
    expect(transport.route).toBe("relay");
    expect(pc.direct).toEqual([]);
  });
});

describe("probing a direct carrier", () => {
  it("proves the PC and makes no session; another key is not the PC", async () => {
    // Given a PC that names its direct carrier
    const pc = await pcFixture();
    const carrier = `ws://${LAN}:${pc.service.status().direct!.carriers[0]!.split(":").at(-1)}`;
    // When the phone probes it with the PC's key, and with another key
    expect(await probeDirect(pc.offer, carrier, pc.directSocket, 2_000)).toBe(true);
    expect(await probeDirect({ ...pc.offer, server_public_key: exportPublicKey(generateKeyPair().publicKey) }, carrier, pc.directSocket, 2_000)).toBe(false);
    // Then the PC holds no session for either
    expect(pc.service.status().sessions).toBe(0);
  });

  it("leaves nothing running after a host that is not the PC never answers the handshake", async () => {
    // Given a host at the address that assigns the connection and then stays silent
    const silent = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request, server) => server.upgrade(request) ? undefined : new Response(null, { status: 426 }),
      websocket: { open: (socket) => { socket.send(JSON.stringify({ type: "assigned", connection_id: "ab".repeat(16) })); }, message() {} } });
    cleanup.push(() => silent.stop(true));
    const live = new Set<unknown>();
    const { setInterval: realSet, clearInterval: realClear } = globalThis;
    globalThis.setInterval = ((callback: () => void, ms?: number) => { const id = realSet(callback, ms); live.add(id); return id; }) as typeof setInterval;
    globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => { live.delete(id); realClear(id); }) as typeof clearInterval;
    cleanup.push(() => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; for (const id of live) realClear(id as never); });
    // When the phone probes it
    const offer: RelayOffer = { v: 1, server_id: "0123456789abcdef0123456789abcdef", server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.test" };
    const proven = await probeDirect(offer, `ws://${LAN}:${silent.port}`, (url) => new WebSocket(url.replace(`ws://${LAN}:`, "ws://127.0.0.1:")), 300);
    // Then it is not the PC, and the handshake's retries stopped with it
    expect(proven).toBe(false);
    expect(live.size).toBe(0);
  });

  it("is never asked to pair", async () => {
    const pc = await pcFixture();
    const carrier = `ws://${LAN}:${pc.service.status().direct!.carriers[0]!.split(":").at(-1)}`;
    const error = await openRelayChannel(pc.offer, { store: new MemoryStore(), direct: carrier, socket: pc.directSocket }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DirectCarrierUnusableError);
    expect(pc.direct).toEqual([]);
  });
});
