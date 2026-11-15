import { afterEach, expect, test } from "bun:test";
import { startBunRelay } from "./bun.ts";
import { relayLimitsFromArgs } from "./bun-limits.ts";
import { CLOSE } from "./core.ts";
import { Peer, establish, newServer, openServer, relayUrls } from "./relay-test-client.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

/** the budget a minute is lifted: these sockets all come from one address within a second, which is what todo 37 paces */
const allow = { async limit() { return { success: true }; } };

test("the Bun relay with --max-clients-per-server 108 --max-sockets-per-address 256 admits 100 machine clients from one address, and its sync names the room and the budget", async () => {
  const limits = relayLimitsFromArgs(["--max-clients-per-server", "108", "--max-sockets-per-address", "256"], {});
  expect([limits.maxClientsPerServer, limits.maxSocketsPerAddress, limits.perAddressPerMinute]).toEqual([108, 256, 120]);
  const relay = startBunRelay({ port: 0, limits, limiters: { perAddress: allow, global: allow } });
  const peers: Peer[] = [];
  cleanup.push(() => relay.stop(), () => { for (const peer of peers) peer.socket.close(); });
  const server = newServer();
  const urls = relayUrls(`ws://127.0.0.1:${relay.port}`, server);
  const control = await openServer(urls.control, server);
  peers.push(control);
  expect(await control.json("sync")).toMatchObject({ type: "sync", connection_ids: [], max_clients: 108, per_address_per_minute: 120, pass_versions: [1, 2, 3] });
  for (let index = 0; index < 108; index++) {
    // the first 100 are machines in the paced lane, the rest phones
    const paced = index < 100;
    const client = await Peer.open(`${urls.client}${paced ? "&lane=paced" : ""}`);
    const { connection_id } = await client.json("assigned") as { connection_id: string };
    expect(await control.json("connected")).toEqual({ type: "connected", connection_id, ...(paced ? { lane: "paced" } : {}) });
    const data = await openServer(urls.data(connection_id), server, connection_id);
    peers.push(client, data);
    await establish({ client, data });
  }
  const refused = await Peer.open(urls.client);
  expect(await refused.closed).toEqual({ code: CLOSE.TRY_AGAIN, reason: "too many clients for this server" });
});

test("the Bun relay refuses a client lane other than paced with 400, before any room", async () => {
  const relay = startBunRelay({ port: 0 });
  cleanup.push(() => relay.stop());
  const client = relayUrls(`http://127.0.0.1:${relay.port}`, newServer()).client;
  const response = await fetch(`${client}&lane=other`);
  expect([response.status, await response.text()]).toEqual([400, "lane must be paced"]);
});
