import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openRelayChannel } from "../../shared/relay-channel.ts";
import type { RelayDevice, RelayDeviceStore } from "../../shared/relay-device.ts";
import { DIRECT_CARRIER, MuxProtocolError } from "../../shared/relay-mux.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { DirectCarrier } from "./direct.ts";
import { loadRelayIdentity } from "./identity.ts";
import { RelayService } from "./service.ts";
import { bounded, deferred, relayConnection, relayDevice, relayFixture } from "./test-helpers.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

/** A PC with its relay identity and a direct carrier on loopback (a test stands in for a private address). */
function directFixture() {
  const fixture = relayFixture();
  const identity = loadRelayIdentity(fixture.stateDir);
  const direct = new DirectCarrier({ identity, services: fixture.app.context.services, port: fixture.app.port,
    addresses: () => ["127.0.0.1"], preferredPort: 0, peerAllowed: () => true });
  direct.start();
  cleanup.push(() => fixture.close(), () => direct.stop());
  const offer: RelayOffer = { v: 1, server_id: identity.server_id, server_public_key: identity.public_key, relay: "wss://relay.ovis.example" };
  const url = (): string => `ws://127.0.0.1:${direct.port}/v1/ws?v=1`;
  return { fixture, identity, direct, offer, url };
}

/** The phone's saved key for the PC, as the hosted app keeps it after pairing through the relay. */
function savedStore(device: Awaited<ReturnType<typeof relayDevice>>, offer: RelayOffer): RelayDeviceStore {
  let saved: RelayDevice | undefined = { server_id: offer.server_id, device_id: device.id, private_key: device.keys.privateKey,
    public_spki: device.publicKey, label: "Phone", server_public_key: offer.server_public_key, relay: offer.relay };
  return {
    get: async () => saved,
    update: async (_id, change) => (saved = change(saved)),
    list: async () => saved ? [saved] : [],
    remove: async () => { saved = undefined; },
  };
}

/** Resolves when the socket opens, rejects when it is refused or closes first. */
function opened(socket: WebSocket): Promise<void> {
  const result = deferred<void>();
  socket.onopen = () => result.resolve();
  socket.onerror = () => result.reject(new Error("refused"));
  socket.onclose = () => result.reject(new Error("closed"));
  return bounded(result.promise);
}

describe("direct carrier", () => {
  it("lets a paired device sign in over the same Noise channel, without the relay", async () => {
    // Given a PC listening directly and a phone paired with it through the relay
    const { fixture, direct, offer, url } = directFixture();
    const device = await relayDevice(fixture);
    // When the phone opens its channel to the PC's address
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()) }));
    cleanup.push(() => channel.close());
    // Then it is admitted as itself, and counted as a session
    expect(channel.device.device_id).toBe(device.id);
    expect(channel.role).toBe("drive");
    expect(direct.sessions).toBe(1);
  });

  it("is not the PC when the key it proves is another one", async () => {
    // Given a phone that pinned another PC's key under this PC's id
    const { fixture, offer, url } = directFixture();
    const device = await relayDevice(fixture);
    const elsewhere = relayFixture();
    cleanup.push(() => elsewhere.close());
    const other = loadRelayIdentity(elsewhere.stateDir);
    const pinned: RelayOffer = { ...offer, server_public_key: other.public_key };
    // When it reaches this address, the handshake against the pinned key fails before anything is sent
    await expect(bounded(openRelayChannel(pinned, { store: savedStore(device, pinned), socket: () => new WebSocket(url()) }))).rejects.toThrow();
  });

  it("ends a direct session when its device is removed", async () => {
    // Given a phone signed in directly
    const { fixture, offer, url } = directFixture();
    const device = await relayDevice(fixture);
    const closed = deferred<Error>();
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()), onClose: (error) => closed.resolve(error) }));
    cleanup.push(() => channel.close());
    // When the PC removes the device
    fixture.app.context.services.devices.revoke(device.id);
    // Then the direct session ends, and the device is not let in again
    await bounded(closed.promise);
    const again = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()) })).catch((caught: unknown) => caught);
    expect(again).toBeInstanceOf(MuxProtocolError);
    expect((again as MuxProtocolError).code).toBe("auth_failed");
  });

  it("pairs nothing: a code sent there is refused and stays unspent", async () => {
    // Given a pairing code the PC shows
    const { fixture, offer, url } = directFixture();
    const store = fixture.app.context.services.devices;
    const code = store.startPairing().code;
    const phone = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const empty: RelayDeviceStore = { get: async () => undefined, update: async (_id, change) => change(undefined), list: async () => [], remove: async () => {} };
    // When a phone sends it over the direct carrier
    const error = await bounded(openRelayChannel({ ...offer, code }, { store: empty, socket: () => new WebSocket(url()) })).catch((caught: unknown) => caught);
    // Then it is refused, and the code still pairs through the relay's path
    expect(error).toBeInstanceOf(MuxProtocolError);
    expect((error as MuxProtocolError).code).toBe("auth_failed");
    const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", phone.publicKey)).toString("base64url");
    expect(store.pairRelay(code, "Phone", publicKey)).toBeTruthy();
  });

  it("holds at most two clients that have not signed in per address", async () => {
    // Given two sockets from one address that never start a handshake
    const { url } = directFixture();
    const first = new WebSocket(url());
    const second = new WebSocket(url());
    cleanup.push(() => first.close(), () => second.close());
    await opened(first);
    await opened(second);
    // When a third comes from the same address, it is refused before upgrade
    const third = new WebSocket(url());
    cleanup.push(() => third.close());
    await expect(opened(third)).rejects.toThrow();
  });

  it("answers only private network peers", async () => {
    // Given the default peer rule, on loopback
    const fixture = relayFixture();
    const strict = new DirectCarrier({ identity: loadRelayIdentity(fixture.stateDir), services: fixture.app.context.services,
      port: fixture.app.port, addresses: () => ["127.0.0.1"], preferredPort: 0 });
    strict.start();
    cleanup.push(() => fixture.close(), () => strict.stop());
    // Then a loopback client is refused
    await expect(opened(new WebSocket(`ws://127.0.0.1:${strict.port}/v1/ws?v=1`))).rejects.toThrow();
  });

  it("ends every direct session when it stops", async () => {
    // Given a phone signed in directly
    const { fixture, direct, offer, url } = directFixture();
    const device = await relayDevice(fixture);
    const closed = deferred<Error>();
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()), onClose: (error) => closed.resolve(error) }));
    cleanup.push(() => channel.close());
    // When direct connections stop, the session ends and nothing listens
    await direct.stop();
    await bounded(closed.promise);
    expect(direct.port).toBeNull();
  });
});

describe("direct carriers in AUTH_OK", () => {
  it("are named only to a phone that offered them", async () => {
    // Given a PC with a direct carrier
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const device = await relayDevice(fixture);
    const carriers = ["ws://192.168.0.10:7319"];
    // When one phone offers DIRECT_CARRIER and another does not
    const offering = await relayConnection(fixture, { directCarriers: () => carriers });
    const plain = await relayConnection(fixture, { directCarriers: () => carriers });
    // Then only the one that offered is told
    expect((await offering.auth(device, [DIRECT_CARRIER])).direct).toEqual(carriers);
    expect(await plain.auth(device)).not.toHaveProperty("direct");
  });

  it("are left out when there are none", async () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const device = await relayDevice(fixture);
    const connection = await relayConnection(fixture, { directCarriers: () => [] });
    expect(await connection.auth(device, [DIRECT_CARRIER])).not.toHaveProperty("direct");
  });
});

describe("direct connections setting", () => {
  it("is on by default and kept off once turned off", async () => {
    // Given a relay service that offers direct connections, with the relay off
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const service = new RelayService({ stateDir: fixture.stateDir, direct: { addresses: () => [] } });
    expect(service.status().direct).toEqual({ on: true, carriers: [] });
    // When it is turned off
    await service.setDirect(false);
    // Then it says so, and a new start reads it back
    expect(JSON.parse(readFileSync(join(fixture.stateDir, "relay", "direct.json"), "utf8"))).toEqual({ on: false });
    expect(new RelayService({ stateDir: fixture.stateDir, direct: {} }).status().direct?.on).toBe(false);
  });

  it("is absent where the server offers no direct connections", () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    expect(new RelayService({ stateDir: fixture.stateDir }).status()).not.toHaveProperty("direct");
    expect(existsSync(join(fixture.stateDir, "relay", "direct.json"))).toBe(false);
  });
});
