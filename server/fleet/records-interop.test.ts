/**
 * The Rust link agent's Noise NK initiator and protected records (crates/fleet-link) against the
 * TypeScript responder, through the built binary's hidden `ovis-link selftest handshake` mode:
 * the binary writes message 1 and its records as hex lines on stdout and reads message 2 and
 * records on stdin, answering each record with one that carries the same frame.
 *
 * Runs on the binary OVIS_LINK_BIN names (missing: a failure), else on the release build of the
 * crate (missing: skipped, as without a Rust toolchain). The link agent steps of CI's `rust-pty-host`
 * job (.github/workflows/ci.yml) build it and set OVIS_LINK_BIN.
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { x25519 } from "@noble/curves/ed25519.js";
import { channelBinding, exportPublicKey, generateKeyPair, openDaemonSecureChannel, type Transport } from "../../shared/relay-e2ee.ts";
import { createNoiseResponder } from "../../shared/vendor/paseo-e2ee/noise/index.ts";
import records from "./vectors/records.json";

const BUILD = join(import.meta.dir, "..", "..", "crates", "fleet-link", "target", "release", `ovis-link${process.platform === "win32" ? ".exe" : ""}`);
const BINARY = process.env["OVIS_LINK_BIN"] ?? BUILD;
const LINE_TIMEOUT_MS = 10_000;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fromHex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));
const buffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** The selftest process, its stdout as lines, and everything it printed. */
function selftest(responderPublic: Uint8Array) {
  const child = Bun.spawn([BINARY, "selftest", "handshake", "--responder-key", hex(responderPublic)], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const lines: string[] = [];
  const printed: string[] = [];
  const wake: { waiting: (() => void) | null } = { waiting: null };
  let ended = false;
  void (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let at: number;
      while ((at = pending.indexOf("\n")) >= 0) {
        lines.push(pending.slice(0, at));
        printed.push(pending.slice(0, at));
        pending = pending.slice(at + 1);
      }
      wake.waiting?.();
    }
    ended = true;
    wake.waiting?.();
  })();
  /** The next stdout line, which must start with `word `; its value. */
  const next = async (word: string): Promise<string> => {
    const deadline = Date.now() + LINE_TIMEOUT_MS;
    while (lines.length === 0) {
      if (ended) throw new Error(`ovis-link ended before a ${word} line`);
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no ${word} line from ovis-link within ${LINE_TIMEOUT_MS} ms`)), Math.max(0, deadline - Date.now())).unref());
      await Promise.race([new Promise<void>((resolve) => { wake.waiting = resolve; }), timeout]);
      wake.waiting = null;
    }
    const line = lines.shift()!;
    expect(line.startsWith(`${word} `), `expected "${word} ...", got ${line.slice(0, 80)}`).toBe(true);
    return line.slice(word.length + 1);
  };
  const send = (word: string, bytes: Uint8Array) => { child.stdin.write(`${word} ${hex(bytes)}\n`); child.stdin.flush(); };
  const finish = async () => {
    child.stdin.end();
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, stderr, stdout: printed.join("\n") };
  };
  return { next, send, finish };
}

/** Every text a key's bytes could take in the output. */
const forms = (key: Uint8Array) => [hex(key), hex(key).toUpperCase(), Buffer.from(key).toString("base64"), Buffer.from(key).toString("base64url")];

describe.skipIf(process.env["OVIS_LINK_BIN"] === undefined && !existsSync(BUILD))("ovis-link selftest handshake against the TypeScript responder", () => {
  it("finds the binary it was given", () => {
    expect(existsSync(BINARY), `${BINARY} does not exist: build it with cargo build --release --manifest-path crates/fleet-link/Cargo.toml`).toBe(true);
  });

  it("opens a channel with shared/relay-e2ee.ts, derives the same binding and carries records both ways", async () => {
    const daemonKeyPair = generateKeyPair();
    const link = selftest(daemonKeyPair.publicKey);
    const received: (string | ArrayBuffer)[] = [];
    let arrived: (() => void) | null = null;
    const toLink: Uint8Array[] = [];
    const transport: Transport = {
      send: (data) => {
        if (typeof data === "string" && data.startsWith("{")) {
          // the daemon's e2ee_ready: its protected message is message 2
          const ready = JSON.parse(data) as { type: string; protected: { v: number; message: string } };
          expect(ready.type).toBe("e2ee_ready");
          link.send("msg2", new Uint8Array(Buffer.from(ready.protected.message, "base64")));
          return;
        }
        // a record: binary as it is, a text frame's record as base64 (secure-channel.ts)
        toLink.push(typeof data === "string" ? new Uint8Array(Buffer.from(data, "base64")) : new Uint8Array(data));
      },
      close: () => {},
      onmessage: null, onclose: null, onerror: null,
    };
    const opening = openDaemonSecureChannel(transport, { daemonKeyPair, events: { onmessage: (data) => { received.push(data); arrived?.(); } } });
    const message1 = fromHex(await link.next("msg1"));
    const hello = { type: "e2ee_hello", key: exportPublicKey(generateKeyPair().publicKey), capabilities: { binaryCiphertext: true }, protected: { v: 1, message: Buffer.from(message1).toString("base64") } };
    transport.onmessage?.({ data: JSON.stringify(hello), isBinary: false });
    const channel = await opening;

    const binding = channelBinding(channel);
    expect(binding).toBeDefined();
    expect(await link.next("binding")).toBe(hex(binding!));

    const deliver = async (wire: Uint8Array) => {
      const count = received.length;
      const got = new Promise<void>((resolve) => { arrived = resolve; });
      transport.onmessage?.({ data: buffer(wire), isBinary: true });
      if (received.length === count) await Promise.race([got, new Promise((_, reject) => setTimeout(() => reject(new Error("the daemon did not deliver the record")), LINE_TIMEOUT_MS).unref())]);
      arrived = null;
      return received.at(-1)!;
    };
    // the initiator's own first record
    expect(Buffer.from((await deliver(fromHex(await link.next("record")))) as ArrayBuffer).toString()).toBe("ovis-link selftest");

    const large = crypto.getRandomValues(new Uint8Array(16384));
    const frames: (string | Uint8Array)[] = [Uint8Array.of(1, 2, 3), "a text frame, ünïcödé", large, new Uint8Array(0)];
    for (const frame of frames) {
      await channel.send(typeof frame === "string" ? frame : buffer(frame));
      expect(toLink.length).toBe(1);
      link.send("record", toLink.shift()!);
      const echoed = await deliver(fromHex(await link.next("record")));
      if (typeof frame === "string") expect(echoed).toBe(frame);
      else expect(hex(new Uint8Array(echoed as ArrayBuffer))).toBe(hex(frame));
    }

    const result = await link.finish();
    expect(result.stdout).toContain(`done ${frames.length}`);
    expect(result.code).toBe(0);
    for (const form of forms(daemonKeyPair.secretKey)) expect(result.stdout + result.stderr).not.toContain(form);
    channel.close();
  });

  it("exits non-zero with `handshake failed` and prints no key byte when one byte of message 2 is flipped", async () => {
    const derivations = records.derivations;
    const staticSecret = fromHex(derivations.responder_static_secret_hex);
    const ephemeralSecret = fromHex(derivations.responder_ephemeral_secret_hex);
    const responder = createNoiseResponder({
      localStatic: { secretKey: staticSecret.slice(), publicKey: x25519.getPublicKey(staticSecret) },
      prologue: fromHex(derivations.prologue_hex),
      ephemeral: { secretKey: ephemeralSecret.slice(), publicKey: x25519.getPublicKey(ephemeralSecret) },
    });
    const link = selftest(x25519.getPublicKey(staticSecret));
    expect(hex(responder.readMessage(fromHex(await link.next("msg1"))))).toBe(derivations.offered_params_hex);
    const message2 = responder.writeMessage(fromHex(derivations.selected_params_hex));
    // the chaining key both ends hold once message 2's ephemeral is mixed in: a byte flipped past
    // the ephemeral key leaves it the same on the Rust side, which then fails to decrypt the payload
    const chainingKey = (responder as unknown as { symmetric: { ck: Uint8Array } }).symmetric.ck.slice();
    const transportKeys = Object.values(responder.split()).map((state) => (state as unknown as { k: Uint8Array }).k.slice());
    for (const secret of [chainingKey, ...transportKeys]) expect(secret.length).toBe(32);
    message2[40]! ^= 0x01;
    link.send("msg2", message2);

    const result = await link.finish();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("handshake failed");
    expect(result.stdout).not.toContain("binding");
    for (const secret of [staticSecret, ephemeralSecret, chainingKey, ...transportKeys]) {
      for (const form of forms(secret)) expect(result.stdout + result.stderr).not.toContain(form);
    }
  });
});
