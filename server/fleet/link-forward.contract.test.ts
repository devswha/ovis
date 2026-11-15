/**
 * The controller's local forwards (server/fleet/forward.ts) through the Rust link agent: the built binary's hidden
 * `ovis-link selftest machine` (as link-interop.contract.test.ts runs it, on a carrier over its stdin and stdout) signs
 * in to a RelaySession counted by a Fleet whose store, in a mkdtemp state folder, holds its key as active. A local
 * client then reaches the agent's targets through the forwards: TCP to its loopback bridge stand-in, the Unix socket to
 * its runtime socket stand-in.
 *
 * Runs on the binary OVIS_LINK_BIN names (missing: a failure), else on the release build of the crate (missing: skipped).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, openDaemonSecureChannel, type Transport } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { RelaySession } from "../relay/session.ts";
import { bounded, deferred, relayFixture } from "../relay/test-helpers.ts";
import { machineFingerprint } from "./mux-ext.ts";
import { Fleet } from "./sessions.ts";
import { FleetStore } from "./store.ts";

const BUILD = join(import.meta.dir, "..", "..", "crates", "fleet-link", "target", "release", "ovis-link");
const BINARY = process.env["OVIS_LINK_BIN"] ?? BUILD;
const MiB = 1024 * 1024;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function listen(server: Server, at: number | string): Promise<void> {
  cleanups.push(() => server.close());
  return new Promise((resolve) => { if (typeof at === "number") server.listen(at, "127.0.0.1", resolve); else server.listen(at, resolve); });
}
const echoServer = () => createServer({ allowHalfOpen: true }, (socket) => { socket.on("error", () => {}); socket.pipe(socket); });

/** The agent signed in to a fleet controller: its targets are a TCP echo and a Unix socket echo. */
async function agentUnderFleet() {
  const dir = folder("ovis-link-forward-");
  const bridge = echoServer();
  await listen(bridge, 0);
  const nativePath = join(dir, "core.sock");
  await listen(echoServer(), nativePath);

  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const scalar = Buffer.from((await crypto.subtle.exportKey("jwk", keys.privateKey)).d!, "base64url");
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const keyFile = join(dir, "machine.key");
  writeFileSync(keyFile, scalar, { mode: 0o600 });
  const controllerKeys = generateKeyPair();
  const config = {
    controller_key: Buffer.from(controllerKeys.publicKey).toString("hex"), machine_key_file: keyFile, runtime_id: "rt-forward", boot_id: "boot-1",
    versions: { server: "0.5.0", agent: "0.5.0", runtime: "0.9.1" },
    bridge_port: (bridge.address() as { port: number }).port, bridge_token: randomBytes(32).toString("hex"),
    native_socket: nativePath, native_bearer: `ovb_${randomBytes(24).toString("base64url")}`,
  };
  const configFile = join(dir, "link.json");
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });

  const stateDir = folder("fleet-state-");
  const store = new FleetStore({ stateDir });
  const machineId = machineFingerprint(spki);
  store.add({ machine_id: machineId, public_key: Buffer.from(spki).toString("base64url"), name: "rust agent" });
  store.setState(machineId, "active");
  const fleet = new Fleet({ stateDir, tokenConfigured: true, store });
  fleet.start();
  cleanups.push(() => fleet.close());

  const fixture = relayFixture();
  cleanups.push(() => fixture.close());
  const child = Bun.spawn([BINARY, "selftest", "machine", "--config", configFile], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { if (child.exitCode === null) child.kill(); });
  const transport: Transport = {
    send: (data) => {
      const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
      const header = Buffer.alloc(5);
      header[0] = typeof data === "string" ? 0 : 1;
      header.writeUInt32BE(bytes.length, 1);
      child.stdin.write(Buffer.concat([header, bytes]));
      child.stdin.flush();
    },
    close: () => { try { child.stdin.end(); } catch { /* already closed */ } },
    onmessage: null, onclose: null, onerror: null,
  };
  void (async () => {
    let pending = Buffer.alloc(0);
    for await (const chunk of child.stdout) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
        const length = pending.readUInt32BE(1);
        const body = pending.subarray(5, 5 + length);
        const text = pending[0] === 0;
        pending = pending.subarray(5 + length);
        transport.onmessage?.(text ? { data: body.toString(), isBinary: false } : { data: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, isBinary: true });
      }
    }
    transport.onclose?.(1006, "agent ended");
  })();
  let session: RelaySession | undefined;
  const advertised = deferred<void>();
  const daemon = await bounded(openDaemonSecureChannel(transport, { daemonKeyPair: controllerKeys, events: { onmessage: (data) => session?.receive(data) } }));
  const controller = new RelaySession({
    channel: daemon, services: fixture.app.context.services, port: fixture.app.port, serverId: deriveServerId(controllerKeys.publicKey),
    serverVersion: "0.5.0", minSupportedClient: "0.4.21", routingOverhead: 0, maxWireMessageBytes: 256 * 1024, fleet, machineSessions: fleet,
  });
  session = controller;
  const receive = controller.receive.bind(controller);
  controller.receive = (data) => { receive(data); if (fleet.advert(machineId)) advertised.resolve(); };
  await bounded(advertised.promise);
  const forward = await fleet.forwardReady(machineId);
  if (!forward) throw new Error("no forward");
  return { forward, fleet, machineId, child, token: config.bridge_token, finish: () => { transport.close(); return child.exited; } };
}

/**
 * One local connection: writes `bytes`, ends, reads everything back. Through the TCP forward it first sends a head with
 * the bridge's `token`, as the roster's client does, which the echo answers back and the result leaves out.
 */
function through(at: number | string, bytes: Uint8Array, token = ""): Promise<Buffer> {
  const head = typeof at === "number" ? Buffer.from(`GET / HTTP/1.1\r\nAuthorization: Bearer ${token}\r\n\r\n`) : Buffer.alloc(0);
  const socket = typeof at === "number" ? connect({ host: "127.0.0.1", port: at, allowHalfOpen: true }) : connect({ path: at, allowHalfOpen: true });
  const chunks: Buffer[] = [];
  const done = deferred<Buffer>();
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.on("error", (error) => done.reject(error));
  socket.on("close", () => done.resolve(Buffer.concat(chunks).subarray(head.length)));
  socket.once("connect", () => socket.end(Buffer.concat([head, bytes])));
  return bounded(done.promise, 60_000);
}

describe.skipIf(process.env["OVIS_LINK_BIN"] === undefined && !existsSync(BUILD))("forwards through ovis-link selftest machine", () => {
  it("copies 4 MiB each way through the TCP forward and through the Unix socket forward at once, SHA-256 equal", async () => {
    const agent = await agentUnderFleet();
    const sent = [randomBytes(4 * MiB), randomBytes(4 * MiB)];
    const [bridged, native] = await Promise.all([through(agent.forward.port, sent[0]!, agent.token), through(agent.forward.socketPath!, sent[1]!)]);
    expect(sha256(bridged)).toBe(sha256(sent[0]!));
    expect(sha256(native)).toBe(sha256(sent[1]!));
    expect(await agent.finish()).toBe(0);
    // the session went with the agent: the forward stays and closes a connection at once
    expect(agent.fleet.online(agent.machineId)).toBe(false);
    await expect(through(agent.forward.port, Buffer.from("x"), agent.token)).rejects.toMatchObject({ code: "ECONNRESET" });
  }, 120_000);
});
