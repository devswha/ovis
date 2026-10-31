import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRelayIdentity, relayIdentityPath, rotateRelayIdentity } from "./identity.ts";
import { privateStateFs } from "../private-state.ts";

const dirs: string[] = [];
const stateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), "relay-identity-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("relay identity", () => {
  it("loads the winning identity when another creator publishes first", () => {
    const dir = stateDir();
    const open = privateStateFs.openSync;
    let competing: ReturnType<typeof loadRelayIdentity> | undefined;
    let entered = false;
    const spy = spyOn(privateStateFs, "openSync").mockImplementation((...args) => {
      // Both callers have seen ENOENT before either can publish its prepared file.
      if (!entered) {
        entered = true;
        competing = loadRelayIdentity(dir);
      }
      return open(...args);
    });
    try {
      const first = loadRelayIdentity(dir);
      if (!competing) throw new Error("Competing creator did not run");
      expect(first).toEqual(competing);
      expect(loadRelayIdentity(dir)).toEqual(competing);
    } finally {
      spy.mockRestore();
    }
  });

  it("creates a private identity file and reuses it", () => {
    const dir = stateDir();
    const first = loadRelayIdentity(dir);
    expect(first.server_id).toMatch(/^[0-9a-f]{32}$/);
    if (process.platform !== "win32") expect(mode(relayIdentityPath(dir))).toBe(0o600);
    expect(loadRelayIdentity(dir)).toEqual(first);
  });

  it("makes an identity file readable by others private again when it loads it", () => {
    const dir = stateDir();
    const saved = loadRelayIdentity(dir);
    const path = relayIdentityPath(dir);
    chmodSync(path, 0o644);
    expect(loadRelayIdentity(dir)).toEqual(saved);
    if (process.platform !== "win32") expect(mode(path)).toBe(0o600);
  });

  it.each(["{not json", "[]", "null", JSON.stringify({ v: 1, server_id: "x", public_key: "a", secret_key: "b" })])(
    "refuses a bad file (%#) and leaves it unchanged", (text) => {
      const dir = stateDir();
      const path = relayIdentityPath(dir);
      mkdirSync(join(dir, "relay"));
      writeFileSync(path, text);
      expect(() => loadRelayIdentity(dir)).toThrow(/identity_unreadable/);
      expect(readFileSync(path, "utf8")).toBe(text);
    });

  it("refuses a key pair whose halves do not match", () => {
    const dir = stateDir();
    const a = loadRelayIdentity(dir);
    const b = rotateRelayIdentity(stateDir());
    const path = relayIdentityPath(dir);
    writeFileSync(path, JSON.stringify({ ...a, public_key: b.public_key }));
    expect(() => loadRelayIdentity(dir)).toThrow(/identity_unreadable/);
  });

  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const flipLastBit = (key: string): string => `${key.slice(0, 42)}${ALPHABET[ALPHABET.indexOf(key[42]!) ^ 1]}=`;
  const corruptions: [string, (key: string) => string][] = [
    ["trailing garbage", (key) => `${key}!!!!`],
    ["wrong length", (key) => key.slice(0, 40) + "A="],
    ["invalid characters", (key) => `*${key.slice(1)}`],
    ["non-canonical encoding", flipLastBit],
  ];
  for (const field of ["secret_key", "public_key"] as const) {
    it.each(corruptions)(`refuses a ${field} with %s and leaves the file unchanged`, (_name, corrupt) => {
      const dir = stateDir();
      const saved = loadRelayIdentity(dir);
      const path = relayIdentityPath(dir);
      const text = JSON.stringify({ ...saved, [field]: corrupt(saved[field]) });
      writeFileSync(path, text);
      expect(() => loadRelayIdentity(dir)).toThrow(/identity_unreadable/);
      expect(readFileSync(path, "utf8")).toBe(text);
    });
  }

  it("rotates to a new server_id and key, keeping the file private", () => {
    const dir = stateDir();
    const before = loadRelayIdentity(dir);
    const after = rotateRelayIdentity(dir);
    expect(after.server_id).not.toBe(before.server_id);
    expect(after.public_key).not.toBe(before.public_key);
    expect(after.secret_key).not.toBe(before.secret_key);
    expect(loadRelayIdentity(dir)).toEqual(after);
    if (process.platform !== "win32") expect(mode(relayIdentityPath(dir))).toBe(0o600);
  });
});
