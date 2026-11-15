/**
 * The Rust link agent's machine session (crates/fleet-link, the built binary's hidden `ovis-link selftest machine`) against
 * a TypeScript controller: a RelaySession with the fleet extension (server/relay/session.ts) on a server started with
 * `port: 0` and a temp state folder, over a carrier on the agent's stdin and stdout (each message: one byte of kind, 0
 * text or 1 binary, a u32 big-endian length, the bytes). The agent runs the protected handshake, signs in with its
 * machine key, advertises its two targets and answers the pipes the controller opens: `bridge` to a loopback TCP server,
 * `native` to a Unix socket, both from its own configuration file.
 *
 * Runs on the binary OVIS_LINK_BIN names (missing: a failure), else on the release build of the crate (missing: skipped,
 * as without a Rust toolchain). CI's `rust-pty-host` job builds it and sets OVIS_LINK_BIN.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, openDaemonSecureChannel, type Transport } from "../../shared/relay-e2ee.ts";
import { MuxStreamError } from "../../shared/relay-mux-engine.ts";
import type { ExtensionFrame, SessionError } from "../../shared/relay-mux.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { RelaySession } from "../relay/session.ts";
import { bounded, deferred, relayFixture } from "../relay/test-helpers.ts";
import { machineFingerprint, PIPE_WINDOW_BYTES } from "./mux-ext.ts";
import type { PipeAdvert, PipeStream } from "./mux-ext.ts";
import { memoryDirectory } from "./test-helpers.ts";

const BUILD = join(import.meta.dir, "..", "..", "crates", "fleet-link", "target", "release", "ovis-link");
const BINARY = process.env["OVIS_LINK_BIN"] ?? BUILD;
const MiB = 1024 * 1024;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** A temp folder of mode 0700; Unix socket paths in it stay short. */
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-link-"));
  chmodSync(dir, 0o700);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listen(server: Server, at: number | string): Promise<void> {
  cleanups.push(() => server.close());
  return new Promise((resolve) => { if (typeof at === "number") server.listen(at, "127.0.0.1", resolve); else server.listen(at, resolve); });
}

/**
 * The machine's loopback bridge stand-in. The first line a connection sends picks what it does: `echo` echoes and
 * ends when its peer ends; `greet` sends `greeting`, ends its direction, and records what it reads until its peer
 * ends; `flood <n>` sends n random bytes and ends; `reset` closes with a TCP reset.
 */
async function bridgeServer() {
  const connections: Socket[] = [];
  const greeted = deferred<Buffer>();
  const flooded = deferred<string>();
  const closed: Promise<void>[] = [];
  const server = createServer((socket) => {
    connections.push(socket);
    closed.push(new Promise((resolve) => socket.on("close", () => resolve())));
    socket.on("error", () => {});
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const at = head.indexOf(0x0a);
      if (at < 0) return;
      socket.off("data", onData);
      const [mode, argument] = head.subarray(0, at).toString().split(" ");
      const rest = head.subarray(at + 1);
      if (mode === "echo") {
        if (rest.length) socket.write(rest);
        socket.pipe(socket);
      } else if (mode === "greet") {
        const got: Buffer[] = [rest];
        socket.on("data", (data) => got.push(data));
        socket.on("end", () => { greeted.resolve(Buffer.concat(got)); socket.end(); });
        socket.end("greeting");
      } else if (mode === "flood") {
        const bytes = randomBytes(Number(argument));
        flooded.resolve(sha256(bytes));
        socket.end(bytes);
      } else if (mode === "reset") socket.resetAndDestroy();
    };
    socket.on("data", onData);
  });
  await listen(server, 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  return { port: address.port, connections, greeted: greeted.promise, flooded: flooded.promise, closed };
}

/** The runtime socket's stand-in: a Unix socket that echoes. */
async function nativeServer(dir: string) {
  const path = join(dir, "core.sock");
  const connections: Socket[] = [];
  const server = createServer((socket) => { connections.push(socket); socket.on("error", () => {}); socket.pipe(socket); });
  await listen(server, path);
  return { path, connections };
}

/** A server that must never be reached: a TCP port and a Unix socket the agent was not given. */
async function sentinels(dir: string) {
  const reached: string[] = [];
  const tcp = createServer((socket) => { reached.push("tcp"); socket.destroy(); });
  const unix = createServer((socket) => { reached.push("unix"); socket.destroy(); });
  await listen(tcp, 0);
  await listen(unix, join(dir, "other.sock"));
  return { reached, port: (tcp.address() as { port: number }).port };
}

interface Targets { readonly bridgePort?: number; readonly nativeSocket?: string }

/** The agent under a controller: its process, the controller's session, and every secret either holds. */
async function link(targets: Targets) {
  const fixture = relayFixture();
  cleanups.push(() => fixture.close());
  const dir = folder();
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const scalar = Buffer.from((await crypto.subtle.exportKey("jwk", keys.privateKey)).d!, "base64url");
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const keyFile = join(dir, "machine.key");
  writeFileSync(keyFile, scalar, { mode: 0o600 });
  const controllerKeys = generateKeyPair();
  const bridgeToken = randomBytes(32).toString("hex");
  const nativeBearer = `ovb_${randomBytes(24).toString("base64url")}`;
  const config = {
    controller_key: hex(controllerKeys.publicKey), machine_key_file: keyFile, runtime_id: "rt-interop", boot_id: "boot-1",
    versions: { server: "0.5.0", agent: "0.5.0", runtime: "0.9.1" },
    ...(targets.bridgePort === undefined ? {} : { bridge_port: targets.bridgePort, bridge_token: bridgeToken }),
    ...(targets.nativeSocket === undefined ? {} : { native_socket: targets.nativeSocket, native_bearer: nativeBearer }),
  };
  const configFile = join(dir, "link.json");
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const fleet = memoryDirectory([{ machine_id: machineFingerprint(spki), public_key: Buffer.from(spki).toString("base64url"), state: "active" }]);

  const child = Bun.spawn([BINARY, "selftest", "machine", "--config", configFile], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  cleanups.push(() => { if (child.exitCode === null) child.kill(); });
  const stdout: Buffer[] = [];
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
      stdout.push(Buffer.from(chunk));
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
  const ended = deferred<SessionError>();
  const advert = deferred<PipeAdvert>();
  const daemon = await bounded(openDaemonSecureChannel(transport, { daemonKeyPair: controllerKeys, events: { onmessage: (data) => session?.receive(data) } }));
  // the channel's keys, while it is open, to look for them in everything the agent printed
  const channelKeys = ["sender", "receiver"].map((field) => ((daemon as unknown as Record<string, { k: Uint8Array }>)[field]!.k).slice());
  const controller = new RelaySession({
    channel: daemon, services: fixture.app.context.services, port: fixture.app.port, serverId: deriveServerId(controllerKeys.publicKey),
    serverVersion: "0.5.0", minSupportedClient: "0.4.21", routingOverhead: 0, maxWireMessageBytes: 256 * 1024, fleet,
    onClose: (code) => ended.resolve(code),
  });
  session = controller;
  const receive = controller.receive.bind(controller);
  controller.receive = (data) => { receive(data); if (controller.pipeAdvert) advert.resolve(controller.pipeAdvert); };
  return {
    child, session: controller, ended: ended.promise, advert: advert.promise, bridgeToken, nativeBearer,
    secrets: [scalar, Buffer.from(bridgeToken, "hex"), Buffer.from(nativeBearer), controllerKeys.secretKey, ...channelKeys].map((bytes) => new Uint8Array(bytes)),
    stdout: () => Buffer.concat(stdout),
    async finish() {
      transport.close();
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      return { code, stderr };
    },
  };
}

/** Opens a pipe and waits for the agent's answer: PIPE_ACCEPT, or the reset it was refused with. */
async function open(session: RelaySession, endpoint: string): Promise<PipeStream> {
  const pipe = session.openPipe(endpoint);
  const answered = deferred<void>();
  pipe.onAccept = () => answered.resolve();
  pipe.onDispose = (error) => answered.reject(error ?? new MuxStreamError("cancelled"));
  await bounded(answered.promise);
  return pipe;
}
async function readAll(pipe: PipeStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of pipe.readable) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function exchange(pipe: PipeStream, writes: Uint8Array[]): Promise<Buffer> {
  const reading = readAll(pipe);
  for (const bytes of writes) await bounded(pipe.write(bytes), 30_000);
  await pipe.end();
  return bounded(reading, 30_000);
}
const line = (text: string) => new TextEncoder().encode(`${text}\n`);
/** Every form a secret could take in what the agent printed. */
const forms = (secret: Uint8Array) => [hex(secret), hex(secret).toUpperCase(), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url")];

describe.skipIf(process.env["OVIS_LINK_BIN"] === undefined && !existsSync(BUILD))("ovis-link selftest machine against a TypeScript controller", () => {
  it("finds the binary it was given", () => {
    expect(existsSync(BINARY), `${BINARY} does not exist: build it with cargo build --release --manifest-path crates/fleet-link/Cargo.toml`).toBe(true);
  });

  it("refuses a key or configuration that is a FIFO or a symbolic link, at once and with exit code 2", async () => {
    const dir = folder();
    const fifo = join(dir, "fifo");
    expect(Bun.spawnSync(["mkfifo", "-m", "600", fifo]).exitCode).toBe(0);
    const key = join(dir, "machine.key");
    writeFileSync(key, randomBytes(32), { mode: 0o600 });
    symlinkSync(key, join(dir, "linked.key"));
    const config = (keyFile: string, name: string) => {
      const path = join(dir, name);
      const versions = { server: "0.5.0", agent: "0.5.0", runtime: "0.9.1" };
      writeFileSync(path, JSON.stringify({ controller_key: hex(randomBytes(32)), machine_key_file: keyFile, bridge_port: 1, bridge_token: hex(randomBytes(32)), runtime_id: "rt", boot_id: "b", versions }), { mode: 0o600 });
      return path;
    };
    for (const [path, refusal] of [
      [config(fifo, "fifo-key.json"), "machine key is not a regular file"],
      [config(join(dir, "linked.key"), "linked-key.json"), "machine key path is a symbolic link"],
      [fifo, "configuration is not a regular file"],
    ] as const) {
      const child = Bun.spawn([BINARY, "selftest", "machine", "--config", path], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      cleanups.push(() => { if (child.exitCode === null) child.kill(); });
      // a blocking open would never exit: the bound fails the test instead of hanging it
      expect(await bounded(child.exited, 5_000)).toBe(2);
      expect(await new Response(child.stderr).text()).toBe(`ovis-link: ${refusal}\n`);
    }
  });

  it("signs in, advertises and copies 4 MiB each way through a bridge pipe and a native pipe", async () => {
    const dir = folder();
    const bridge = await bridgeServer();
    const native = await nativeServer(dir);
    const agent = await link({ bridgePort: bridge.port, nativeSocket: native.path });
    const advert = await bounded(agent.advert);
    expect(advert).toMatchObject({
      endpoints: ["bridge", "native"], runtime_id: "rt-interop", boot_id: "boot-1", bridge_token: agent.bridgeToken, native_bearer: agent.nativeBearer,
      health: { runtime: "up", bridge: "up" }, versions: { server: "0.5.0", agent: "0.5.0", runtime: "0.9.1" },
    });
    expect(Math.abs(advert.now - Date.now() / 1000)).toBeLessThan(60);

    // 4 MiB each way on both endpoints at once, then writes on either side of the 16376-byte frame payload
    const big = [randomBytes(4 * MiB), randomBytes(4 * MiB)];
    const [bridged, nativeEcho] = await Promise.all([
      exchange(await open(agent.session, "bridge"), [line("echo"), big[0]!]),
      exchange(await open(agent.session, "native"), [big[1]!]),
    ]);
    expect(sha256(bridged.subarray(0))).toBe(sha256(big[0]!));
    expect(sha256(nativeEcho)).toBe(sha256(big[1]!));
    const sizes = [1, 16375, 16376, 16377, 32752, 65536].map((size) => randomBytes(size));
    const echoed = await exchange(await open(agent.session, "bridge"), [line("echo"), ...sizes]);
    expect(echoed.equals(Buffer.concat(sizes))).toBe(true);
    expect(bridge.connections.length).toBe(2);
    expect(native.connections.length).toBe(1);

    const result = await agent.finish();
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("the carrier was lost");
  }, 60_000);

  it("half-closes each way: the target ends first and still reads what the controller sends", async () => {
    const bridge = await bridgeServer();
    const agent = await link({ bridgePort: bridge.port });
    await bounded(agent.advert);
    const pipe = await open(agent.session, "bridge");
    const reading = readAll(pipe);
    await pipe.write(line("greet"));
    // the target's END arrives while this direction is still open
    expect((await bounded(reading)).toString()).toBe("greeting");
    await pipe.write(new TextEncoder().encode("after the target ended"));
    await pipe.end();
    expect((await bounded(bridge.greeted)).toString()).toBe("after the target ended");
    expect(await agent.finish()).toMatchObject({ code: 0 });
  });

  it("holds to the window when the controller does not read, then delivers everything", async () => {
    const bridge = await bridgeServer();
    const agent = await link({ bridgePort: bridge.port });
    await bounded(agent.advert);
    const pipe = await open(agent.session, "bridge");
    const full = deferred<void>();
    const receive = pipe.receive.bind(pipe);
    pipe.receive = (frame: ExtensionFrame) => { receive(frame); if (pipe.inboundBytes > PIPE_WINDOW_BYTES - 16376) full.resolve(); };
    await pipe.write(line(`flood ${4 * MiB}`));
    await bounded(full.promise);
    // a round trip through the agent: every DATA it could send would have come before the PONG
    await bounded(agent.session.mux.measure());
    expect(pipe.inboundBytes).toBeLessThanOrEqual(PIPE_WINDOW_BYTES);
    expect(pipe.inboundBytes).toBeGreaterThan(PIPE_WINDOW_BYTES - 16376);
    const reading = readAll(pipe);
    await pipe.end();
    expect(sha256(await bounded(reading, 30_000))).toBe(await bridge.flooded);
    expect(await agent.finish()).toMatchObject({ code: 0 });
  }, 60_000);

  it("ends the target's connection on the controller's RESET, and resets upstream_lost when the target resets", async () => {
    const bridge = await bridgeServer();
    const agent = await link({ bridgePort: bridge.port });
    await bounded(agent.advert);
    const pipe = await open(agent.session, "bridge");
    await pipe.write(line("echo"));
    pipe.reset("cancelled");
    await bounded(bridge.closed[0]!);

    const lost = await open(agent.session, "bridge");
    const failed = deferred<string>();
    lost.onDispose = (error) => failed.resolve(error?.code ?? "none");
    await lost.write(line("reset"));
    expect(await bounded(failed.promise)).toBe("upstream_lost");

    // the session is still up: a new pipe works
    expect((await exchange(await open(agent.session, "bridge"), [line("echo"), new TextEncoder().encode("still here")])).toString()).toBe("still here");
    expect(await agent.finish()).toMatchObject({ code: 0 });
  });

  it("answers RESET refused to an endpoint it was not given, reaches no other target and starts no process", async () => {
    const dir = folder();
    const bridge = await bridgeServer();
    const others = await sentinels(dir);
    const agent = await link({ bridgePort: bridge.port });
    await bounded(agent.advert);
    // `shell`, a name that resolves to loopback, a port, a socket name and the native endpoint it did not advertise
    for (const endpoint of ["shell", "localhost", "loopback", "ip6-localhost", `tcp-${others.port}`, "unix", "native"]) {
      let error: unknown;
      try { await open(agent.session, endpoint); } catch (caught) { error = caught; }
      expect(error, endpoint).toBeInstanceOf(MuxStreamError);
      expect((error as MuxStreamError).code, endpoint).toBe("refused");
    }
    const children = Bun.spawnSync(["pgrep", "-P", String(agent.child.pid)]);
    expect(children.stdout.toString()).toBe("");
    expect(children.exitCode).toBe(1);
    expect(others.reached).toEqual([]);
    expect(bridge.connections.length).toBe(0);
    // the session survived every refusal
    expect((await exchange(await open(agent.session, "bridge"), [line("echo"), new TextEncoder().encode("ok")])).toString()).toBe("ok");

    const result = await agent.finish();
    const printed = agent.stdout();
    for (const secret of agent.secrets) {
      expect(printed.indexOf(Buffer.from(secret))).toBe(-1);
      for (const form of forms(secret)) expect(result.stderr + printed.toString("latin1")).not.toContain(form);
    }
  });
});
