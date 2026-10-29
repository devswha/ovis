import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { x25519 } from "@noble/curves/ed25519.js";
import { PASEO_FILES } from "../scripts/vendor-paseo.ts";
import {
  exportPublicKey, generateKeyPair, openClientSecureChannel, openDaemonSecureChannel,
  PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE, PROTECTED_RECORD_FAILED_CLOSE_CODE,
  type KeyPair, type SecureChannel, type Transport, type TransportMessage,
} from "./relay-e2ee.ts";
import { createDaemonChannel } from "./vendor/paseo-e2ee/encrypted-channel.ts";
import {
  createNoiseInitiator, createNoiseResponder, NOISE_NK_PROTOCOL_NAME,
} from "./vendor/paseo-e2ee/noise/index.ts";
import fixture from "./vendor/paseo-e2ee/noise/fixtures/nk-25519-chachapoly-sha256.json";

const vendor = join(import.meta.dir, "vendor/paseo-e2ee");
const fromHex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const keyPair = (text: string) => {
  const secretKey = fromHex(text);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
};

it("matches every vendored file against the README SHA-256 manifest", () => {
  // Given the shipped manifest, even when the probe points at a scratch tree.
  const root = process.env["PASEO_VENDOR_CHECK_DIR"] ?? vendor;
  const manifest = readFileSync(join(vendor, "README.md"), "utf8");
  const rows = [...manifest.matchAll(/^\| `([^`]+)` \| `([a-f0-9]{64})` \|$/gm)];
  const actualFiles = [...new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true })]
    .filter((file) => file !== "README.md" && !file.startsWith("dist/")).sort();
  expect(rows.map((row) => row[1]).sort()).toEqual([...PASEO_FILES].sort());
  expect(actualFiles).toEqual([...PASEO_FILES].sort());
  // When bytes are hashed, then every source, fixture, license and config agrees.
  for (const row of rows) {
    const [, file, expected] = row;
    if (!file || !expected) throw new Error("Invalid vendor manifest row");
    const digest = createHash("sha256").update(readFileSync(join(root, file))).digest("hex");
    expect(digest, `SHA-256 mismatch: ${file}`).toBe(expected);
  }
  console.log(`SHA-256 verified: ${rows.length} files`);
});

describe("Noise NK reference vectors", () => {
  // The override permits a scratch-fixture negative probe without touching shipped bytes.
  const vectors: typeof fixture = process.env["PASEO_VECTOR_FIXTURE"]
    ? JSON.parse(readFileSync(process.env["PASEO_VECTOR_FIXTURE"], "utf8"))
    : fixture;
  it("contains both independent reference vectors", () => {
    expect(vectors.vectors).toHaveLength(2);
    console.log(`Noise NK vector count: ${vectors.vectors.length}`);
  });
  for (const vector of vectors.vectors) {
    it(`matches the real ciphertexts from ${vector.source}`, () => {
      // Given fixed keys and prologues from the upstream third-party fixture.
      expect(vector.name).toBe(NOISE_NK_PROTOCOL_NAME);
      const localStatic = keyPair(vector.resp_static);
      expect(hex(localStatic.publicKey)).toBe(vector.init_remote_static);
      const initiator = createNoiseInitiator({
        remoteStatic: fromHex(vector.init_remote_static),
        prologue: fromHex(vector.init_prologue), ephemeral: keyPair(vector.init_ephemeral),
      });
      const responder = createNoiseResponder({
        localStatic, prologue: fromHex(vector.resp_prologue),
        ephemeral: keyPair(vector.resp_ephemeral),
      });
      const [m1, m2, ...messages] = vector.messages;
      if (!m1 || !m2) throw new Error("Vector needs two handshake messages");
      // When the full handshake and both transport directions run, then bytes match.
      const first = initiator.writeMessage(fromHex(m1.payload));
      expect(hex(first)).toBe(m1.ciphertext);
      expect(hex(responder.readMessage(first))).toBe(m1.payload);
      const second = responder.writeMessage(fromHex(m2.payload));
      expect(hex(second)).toBe(m2.ciphertext);
      expect(hex(initiator.readMessage(second))).toBe(m2.payload);
      expect(initiator.isComplete()).toBe(true);
      expect(responder.isComplete()).toBe(true);
      if (vector.handshake_hash !== undefined) {
        expect(hex(initiator.handshakeHash())).toBe(vector.handshake_hash);
        expect(hex(responder.handshakeHash())).toBe(vector.handshake_hash);
      }
      const client = initiator.split();
      const daemon = responder.split();
      messages.forEach((message, index) => {
        const sender = index % 2 === 0 ? client.send : daemon.send;
        const receiver = index % 2 === 0 ? daemon.receive : client.receive;
        const ciphertext = sender.encryptWithAd(new Uint8Array(0), fromHex(message.payload));
        expect(hex(ciphertext)).toBe(message.ciphertext);
        expect(hex(receiver.decryptWithAd(new Uint8Array(0), ciphertext))).toBe(message.payload);
      });
    });
  }
});

// A message-oriented link: callbacks are installed before sends, and held records
// let the relay corrupt exact wire bytes without replacing any cryptography.
class MemoryTransport implements Transport {
  onmessage: Transport["onmessage"] = null;
  onclose: Transport["onclose"] = null;
  onerror: Transport["onerror"] = null;
  peer: MemoryTransport | null = null;
  readonly sent: TransportMessage[] = [];
  readonly closes: number[] = [];
  held = false;
  closed = false;

  async send(data: string | ArrayBuffer): Promise<void> {
    if (this.closed || !this.peer) throw new Error("Transport is not connected");
    const message = { data, isBinary: typeof data !== "string" };
    this.sent.push(message);
    if (!this.held) await this.peer.deliver(message);
  }

  async deliver(message: TransportMessage): Promise<void> {
    if (!this.closed) await this.onmessage?.(message);
  }

  close(code = 1000, reason = "test teardown"): void {
    if (this.closed) return;
    this.closed = true;
    this.closes.push(code);
    this.onclose?.(code, reason);
    this.peer?.close(code, reason);
  }
}

const links: MemoryTransport[] = [];
afterEach(() => {
  for (const link of links.splice(0)) link.close();
});
function pair() {
  const client = new MemoryTransport();
  const daemon = new MemoryTransport();
  client.peer = daemon;
  daemon.peer = client;
  links.push(client, daemon);
  return { client, daemon };
}

async function connected(daemonKeyPair: KeyPair = generateKeyPair()) {
  const link = pair();
  const received = { client: [] as (string | ArrayBuffer)[], daemon: [] as (string | ArrayBuffer)[] };
  const daemonOpening = openDaemonSecureChannel(link.daemon, {
    daemonKeyPair, minimumMode: "protected",
    events: { onmessage: (data) => received.daemon.push(data) },
  });
  let client: SecureChannel | undefined;
  try {
    client = await openClientSecureChannel(link.client, {
      daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey), minimumMode: "protected",
      events: { onmessage: (data) => received.client.push(data) },
    });
    const daemon = await daemonOpening;
    expect(client.isOpen()).toBe(true);
    expect(daemon.isOpen()).toBe(true);
    return { link, client, daemon, received };
  } catch (error) {
    client?.close();
    link.client.close();
    throw error;
  }
}

it("negotiates protected mode and round-trips text and binary in both directions", async () => {
  // Given two endpoints pinned to protected mode.
  const { client, daemon, received } = await connected();
  expect(client.securityMode()).toBe("protected");
  expect(daemon.securityMode()).toBe("protected");
  console.log(`Negotiated mode: client=${client.securityMode()} daemon=${daemon.securityMode()}`);
  // When each frame kind crosses the actual secure channels in both directions.
  for (const payload of ["protected text", new Uint8Array([0, 255, 1, 128]).buffer]) {
    await client.send(payload);
    await daemon.send(payload);
  }
  // Then the application receives exact values and frame kinds.
  expect(received.client).toEqual(["protected text", new Uint8Array([0, 255, 1, 128]).buffer]);
  expect(received.daemon).toEqual(received.client);
});

it("refuses a legacy-only daemon when the client is pinned to protected", async () => {
  // Given a real legacy daemon, not a fabricated ready response.
  const link = pair();
  const keys = generateKeyPair();
  const received: (string | ArrayBuffer)[] = [];
  const daemonOpening = createDaemonChannel(link.daemon, keys).then(
    (channel) => ({ channel, error: undefined }),
    (error: unknown) => ({ channel: undefined, error }),
  );
  // When a pinned client receives its legacy ready.
  const client = await openClientSecureChannel(link.client, {
    daemonPublicKeyB64: exportPublicKey(keys.publicKey), minimumMode: "protected",
    events: { onmessage: (data) => received.push(data) },
  });
  const daemonResult = await daemonOpening;
  expect(daemonResult.error).toBeInstanceOf(Error);
  // Then no application data is sent and the client closes before opening.
  expect(client.isOpen()).toBe(false);
  expect(link.client.closes).toEqual([PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE]);
  expect(received).toEqual([]);
  expect(link.client.sent).toHaveLength(1);
});

function bytes(message: TransportMessage): Uint8Array {
  return typeof message.data === "string"
    ? new Uint8Array(Buffer.from(message.data, "base64"))
    : new Uint8Array(message.data);
}
function record(data: Uint8Array): TransportMessage {
  return { data: new Uint8Array(data).buffer, isBinary: true };
}
function concatenate(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

for (const direction of ["client", "daemon"] as const) {
  for (const attack of ["replayed", "reordered", "truncated", "duplicated", "injected"] as const) {
    it(`closes ${direction} on ${attack} records without delivering plaintext`, async () => {
      // Given fresh protected keys and a relay holding a multi-chunk binary record.
      const keys = generateKeyPair();
      const session = await connected(keys);
      const sender = direction === "client" ? session.daemon : session.client;
      const outgoing = direction === "client" ? session.link.daemon : session.link.client;
      const incoming = session.link[direction];
      outgoing.held = true;
      await sender.send(new Uint8Array(70_000).fill(7).buffer);
      const captured = outgoing.sent.at(-1);
      if (!captured) throw new Error("No record captured");
      const original = bytes(captured);
      let hostile: Uint8Array;
      switch (attack) {
        case "replayed": {
          // A ciphertext from another authenticated session must fail on fresh keys.
          const old = await connected(keys);
          const oldOutgoing = direction === "client" ? old.link.daemon : old.link.client;
          const oldSender = direction === "client" ? old.daemon : old.client;
          oldOutgoing.held = true;
          await oldSender.send(new Uint8Array([42]).buffer);
          const previous = oldOutgoing.sent.at(-1);
          if (!previous) throw new Error("No replay record captured");
          hostile = bytes(previous);
          old.client.close();
          break;
        }
        case "reordered": {
          // Forward the second record before the held first one.
          await sender.send(new Uint8Array([8]).buffer);
          const second = outgoing.sent.at(-1);
          if (!second) throw new Error("No second record captured");
          hostile = bytes(second);
          break;
        }
        case "truncated": hostile = original.slice(0, -1); break;
        case "duplicated": hostile = concatenate(original, original); break;
        case "injected": {
          hostile = original.slice();
          // Flip ciphertext, keeping the length framing valid.
          const byte = hostile[5];
          if (byte === undefined) throw new Error("Record too short");
          hostile[5] = byte ^ 1;
          break;
        }
      }
      // When the hostile relay forwards corruption, then close is immediate and
      // neither partial nor complete plaintext from that record is delivered.
      await incoming.deliver(record(hostile));
      expect(session[direction].isOpen()).toBe(false);
      expect(incoming.closes).toEqual([direction === "client" ? PROTECTED_RECORD_FAILED_CLOSE_CODE : 1011]);
      expect(session.received[direction]).toEqual([]);
      await incoming.deliver(captured);
      expect(session.received[direction]).toEqual([]);
    });
  }
  it(`closes ${direction} on a duplicate after a valid record without redelivering it`, async () => {
    // Given a valid record already delivered once on this session.
    const session = await connected();
    const sender = direction === "client" ? session.daemon : session.client;
    const outgoing = direction === "client" ? session.link.daemon : session.link.client;
    const incoming = session.link[direction];
    const payload = new Uint8Array([1, 2, 3]).buffer;
    await sender.send(payload);
    expect(session.received[direction]).toEqual([payload]);
    const captured = outgoing.sent.at(-1);
    if (!captured) throw new Error("No record captured");
    // When the relay repeats it, then the counter rejects it without redelivery.
    await incoming.deliver(captured);
    expect(session[direction].isOpen()).toBe(false);
    expect(incoming.closes).toEqual([direction === "client" ? PROTECTED_RECORD_FAILED_CLOSE_CODE : 1011]);
    expect(session.received[direction]).toEqual([payload]);
  });
}
