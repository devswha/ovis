/**
 * This server's identity on the relay: a random server_id and the X25519 key pair phones pin.
 * It lives in `stateDir/relay/identity.json` (0600, written through private-state.ts) and nowhere
 * else; the secret key is never logged. A file that will not parse is never replaced: the relay
 * refuses to start with `identity_unreadable`, since a silent new identity would orphan every
 * paired phone. Only rotateRelayIdentity replaces it, on the user's explicit reset.
 */
import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import nacl from "tweetnacl";
import { exportPublicKey, exportSecretKey, generateKeyPair, importPublicKey, importSecretKey } from "../../shared/relay-e2ee.ts";
import { SERVER_ID_PATTERN } from "../../shared/relay-offer.ts";
import { preparePrivateState, syncDirectory, writePrivateState } from "../private-state.ts";

export interface RelayIdentity {
  v: 1;
  server_id: string;
  /** base64, as the vendored key helpers encode it */
  public_key: string;
  secret_key: string;
}

export class RelayIdentityError extends Error {
  readonly code = "identity_unreadable";
  constructor(detail: string) {
    super(`identity_unreadable: ${detail}`);
    this.name = "RelayIdentityError";
  }
}

export const relayIdentityPath = (stateDir: string): string => join(stateDir, "relay", "identity.json");

/** The saved identity, or a new one written on first use. Throws RelayIdentityError on a bad file. */
export function loadRelayIdentity(stateDir: string): RelayIdentity {
  const path = relayIdentityPath(stateDir);
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RelayIdentityError("the file cannot be read");
    return createIdentity(path);
  }
  return parseIdentity(text);
}

/** Replaces the identity with a new server_id and key pair, atomically. */
export function rotateRelayIdentity(stateDir: string): RelayIdentity {
  return createIdentity(relayIdentityPath(stateDir), true);
}

function createIdentity(path: string, replace = false): RelayIdentity {
  const pair = generateKeyPair();
  const identity: RelayIdentity = {
    v: 1,
    server_id: randomBytes(16).toString("hex"),
    public_key: exportPublicKey(pair.publicKey),
    secret_key: exportSecretKey(pair.secretKey),
  };
  if (replace) {
    writePrivateState(path, identity);
    return identity;
  }
  // Publish complete, flushed bytes without replacing another creator's identity.
  const temporary = preparePrivateState(path, identity);
  try {
    try { linkSync(temporary, path); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      return parseIdentity(readFileSync(path, "utf8"));
    }
  } finally {
    unlinkSync(temporary);
  }
  syncDirectory(dirname(path), process.platform);
  return identity;
}

function isCanonical(text: string, encode: (key: Uint8Array) => string, decode: (text: string) => Uint8Array): boolean {
  return /^[A-Za-z0-9+/]{43}=$/.test(text) && encode(decode(text)) === text;
}

function parseIdentity(text: string): RelayIdentity {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new RelayIdentityError("the file is not valid JSON"); }
  if (typeof value !== "object" || value === null) throw new RelayIdentityError("the file is not an identity");
  const o = value as Record<string, unknown>;
  if (o.v !== 1 || typeof o.server_id !== "string" || !SERVER_ID_PATTERN.test(o.server_id)
    || typeof o.public_key !== "string" || typeof o.secret_key !== "string") {
    throw new RelayIdentityError("the file has missing or invalid fields");
  }
  try {
    // The vendored decoder ignores bytes after the padding, so insist on the canonical encoding itself.
    if (!isCanonical(o.public_key, exportPublicKey, importPublicKey) || !isCanonical(o.secret_key, exportSecretKey, importSecretKey)) {
      throw new Error("not canonical");
    }
    const publicKey = importPublicKey(o.public_key);
    const secretKey = importSecretKey(o.secret_key);
    const derived = nacl.box.keyPair.fromSecretKey(secretKey).publicKey;
    if (!nacl.verify(derived, publicKey)) throw new Error("mismatch");
  } catch { throw new RelayIdentityError("the key pair is invalid"); }
  return { v: 1, server_id: o.server_id, public_key: o.public_key, secret_key: o.secret_key };
}
