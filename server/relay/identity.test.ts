import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRelayIdentity, relayIdentityPath, rotateRelayIdentity } from "./identity.ts";

const dirs: string[] = [];
const stateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), "relay-identity-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("relay identity", () => {
  it("creates a private identity file and reuses it", () => {
    const dir = stateDir();
    const first = loadRelayIdentity(dir);
    expect(first.server_id).toMatch(/^[0-9a-f]{32}$/);
    if (process.platform !== "win32") expect(mode(relayIdentityPath(dir))).toBe(0o600);
    expect(loadRelayIdentity(dir)).toEqual(first);
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
