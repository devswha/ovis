/**
 * Load smoke for the relay: `bun relay/load-smoke.ts --pcs 200 --clients 4 [--frames 50] [--url ws://host:port] [--server-pass fleet=<n>]`.
 * Without --url it starts the Bun relay in this process. Each PC opens its control socket, then
 * its clients one after another with a data socket each; then every client and every data socket
 * send --frames random binary frames at once. It prints how many clients the PC answered and how
 * many the relay closed (by close code), frames sent and received each way, and exits 1 unless
 * every client was answered and every frame arrived, byte for byte and in order.
 *
 * `--server-pass fleet=<n>` gives each PC a v3 relay pass with that fleet number (shared/relay-pass.ts), signed with a
 * key made for this run, which the local relay trusts (with passes off: it reads the pass for its room size and
 * refuses nobody). A relay at --url does not know that key, so the flag needs the local one.
 */
import { startBunRelay } from "./bun.ts";
import { passPolicy } from "./pass.ts";
import { RELAY_PASS_HEADER, signRelayPass } from "../shared/relay-pass.ts";
import { Peer, equalBytes, newServer, openServer, relayUrls, within, type Received } from "./relay-test-client.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1]! : fallback;
};
const count = (name: string, fallback: number) => {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
};
const pcs = count("pcs", 200);
const clientsPerPc = count("clients", 4);
const frames = count("frames", 50);
const deadlineMs = count("timeout-ms", 120_000);
const serverPass = option("server-pass", "");
const fleet = serverPass === "" ? null : Number(/^fleet=(\d+)$/.exec(serverPass)?.[1] ?? NaN);
if (fleet !== null && (!Number.isInteger(fleet) || fleet < 1)) throw new Error("--server-pass takes fleet=<n>, n a positive integer");
if (fleet !== null && args.includes("--url")) throw new Error("--server-pass needs the local relay: a relay at --url does not trust this run's key");

/** the pass key, made for this run only */
const KID = "10ad5a0e";
const signer = fleet === null ? null : await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
const pass = signer === null ? undefined : await passPolicy({ RELAY_PASS_MODE: "off",
  RELAY_PASS_KEYS: `${KID}:${Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", signer.publicKey)), (byte) => byte.toString(16).padStart(2, "0")).join("")}` });

const connections = pcs * (1 + 2 * clientsPerPc);
const local = args.includes("--url") ? null : startBunRelay({ port: 0, ...(pass ? { pass } : {}), limits: {
  perAddressPerMinute: connections, globalPerMinute: connections, maxSockets: connections, maxRooms: pcs, maxSocketsPerAddress: connections,
} });
const base = local ? `ws://127.0.0.1:${local.port}` : option("url", "");

const frame = () => crypto.getRandomValues(new Uint8Array(1 + Math.floor(Math.random() * 16 * 1024)));

const totals = { up: { sent: 0, received: 0, mismatched: 0 }, down: { sent: 0, received: 0, mismatched: 0 } };
const clients = { answered: 0, closed: new Map<number, number>() };
const rooms = new Map<unknown, number>();

/** sends `frames` frames from one end and checks each at the other, in order */
async function stream(from: Peer, to: Peer, tally: { sent: number; received: number; mismatched: number }) {
  const sent = Array.from({ length: frames }, frame);
  for (const bytes of sent) { from.socket.send(bytes); tally.sent++; }
  for (const bytes of sent) {
    const got = await to.next("a relayed frame", deadlineMs);
    tally.received++;
    if (!equalBytes(got, bytes)) tally.mismatched++;
  }
}

/** a peer's next frame, or its close if that comes first */
function nextOrClose(peer: Peer, what: string): Promise<{ frame: Received } | { code: number }> {
  return within(new Promise((resolve) => {
    peer.next(what, deadlineMs).then((got) => resolve({ frame: got }), () => {});
    void peer.closed.then((close) => resolve({ code: close.code }));
  }), what, deadlineMs);
}

const started = performance.now();
let failure: unknown = null;
const sockets: Peer[] = [];
try {
  const pairs = await within(Promise.all(Array.from({ length: pcs }, async () => {
    const server = newServer();
    const urls = relayUrls(base, server);
    const headers = signer ? { [RELAY_PASS_HEADER]: await signRelayPass(signer.privateKey, KID, server.serverId, Math.floor(Date.now() / 1000), undefined, { fleet: fleet! }) } : undefined;
    const control = await openServer(urls.control, server, null, headers);
    sockets.push(control);
    const sync = await control.json("sync");
    rooms.set(sync["max_clients"], (rooms.get(sync["max_clients"]) ?? 0) + 1);
    const out = [];
    for (let index = 0; index < clientsPerPc; index++) {
      const client = await Peer.open(urls.client);
      sockets.push(client);
      const assigned = await nextOrClose(client, "assigned");
      if ("code" in assigned) { clients.closed.set(assigned.code, (clients.closed.get(assigned.code) ?? 0) + 1); continue; }
      const connectionId = (JSON.parse(assigned.frame as string) as { connection_id: string }).connection_id;
      const connected = await control.json("connected");
      if (connected["connection_id"] !== connectionId) throw new Error("control heard of another client");
      const data = await openServer(urls.data(connectionId), server, connectionId, headers);
      sockets.push(data);
      // the PC answers the client's handshake: only then does it hold one of the room's places
      data.socket.send("handshake answer");
      const answer = await nextOrClose(client, "the PC's first frame");
      if ("code" in answer) { clients.closed.set(answer.code, (clients.closed.get(answer.code) ?? 0) + 1); continue; }
      if (answer.frame !== "handshake answer") throw new Error("the client heard another first frame");
      clients.answered++;
      out.push({ client, data });
    }
    return out;
  })), "every PC and client to connect", deadlineMs).then((all) => all.flat());
  console.log(`connected: ${pcs} PCs, ${pairs.length} clients, ${pairs.length} data sockets in ${Math.round(performance.now() - started)} ms`);
  await within(Promise.all(pairs.flatMap((pair) => [stream(pair.client, pair.data, totals.up), stream(pair.data, pair.client, totals.down)])), "every frame", deadlineMs);
} catch (error) {
  failure = error;
}
const memory = process.memoryUsage();
for (const socket of sockets) socket.socket.close();
await local?.stop();

const dropped = totals.up.sent - totals.up.received + totals.down.sent - totals.down.received;
const mismatched = totals.up.mismatched + totals.down.mismatched;
const closed = [...clients.closed].map(([code, times]) => `${times} closed ${code}`).join(", ");
console.log(`rooms: ${[...rooms].map(([size, times]) => `${times} of max_clients ${String(size)}`).join(", ")}${fleet === null ? "" : ` (pass fleet=${fleet})`}`);
console.log(`clients: ${clients.answered} answered${closed ? `, ${closed}` : ""} of ${pcs * clientsPerPc}`);
console.log(`client -> PC: sent ${totals.up.sent}, received ${totals.up.received}, mismatched ${totals.up.mismatched}`);
console.log(`PC -> client: sent ${totals.down.sent}, received ${totals.down.received}, mismatched ${totals.down.mismatched}`);
console.log(`dropped ${dropped}, mismatched ${mismatched}, ${Math.round(performance.now() - started)} ms`);
console.log(`memory of this process${local ? " (the relay and its test peers)" : ""}: rss ${(memory.rss / 2 ** 20).toFixed(1)} MiB, heap used ${(memory.heapUsed / 2 ** 20).toFixed(1)} MiB`);
if (failure) console.log(`error: ${failure instanceof Error ? failure.message : String(failure)}`);
const ok = !failure && clients.answered === pcs * clientsPerPc && dropped === 0 && mismatched === 0 && totals.up.sent === pcs * clientsPerPc * frames;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
