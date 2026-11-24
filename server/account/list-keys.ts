/**
 * This PC's own keys in its account's signed list (docs/account-list.md): a signing key, which the list knows the PC
 * by, and an encryption key, which the keys to the names are wrapped to. They live in `account-list-keys.json` in the
 * state folder (0600, written through private-state.ts) and belong to one relay identity: a reset relay identity is a
 * new PC, so keys made for another identity are replaced, never used. Neither secret is logged, and neither leaves
 * this module but as a CryptoKey that cannot be exported.
 *
 * A file that will not read is never replaced by itself: a list that knows this PC's key would then hold a key nobody
 * has, with no word of it. The PC follows its list all the same and says so (`ListKeysError`); a reset relay identity
 * makes new keys.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { verifySignature } from "../../shared/account-list-entry.ts";
import { generateStoredEncryptionKey, ListSealError, LIST_STORED_KEY_TEXT_LENGTH, readStoredEncryptionKey } from "../../shared/account-list-seal.ts";
import { SERVER_ID_PATTERN } from "../../shared/relay-offer.ts";
import { fromBase64Url } from "../../shared/relay-pair-sas.ts";
import { writePrivateState } from "../private-state.ts";

export const ACCOUNT_LIST_KEYS_FILE = "account-list-keys.json";

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const PROBE = new TextEncoder().encode("ovis-list-keys-check/1");

/** The file: both secrets are the 138-byte PKCS8 of a P-256 private key, as base64url (the form of a join line's secret). */
interface KeysFile {
  readonly v: 1;
  readonly server_id: string;
  readonly signing: string;
  readonly encryption: string;
}

export interface PcListKeys {
  /** The relay identity these keys were made for. */
  readonly serverId: string;
  /** The PC's signing key, as the list spells a key. */
  readonly key: string;
  /** Signs entries and the PC's card; it cannot be exported. */
  readonly privateKey: CryptoKey;
  /** The PC's encryption key, as the list spells a key. */
  readonly enc: string;
  /** Opens the wraps made to `enc`; it cannot be exported. */
  readonly encPrivateKey: CryptoKey;
}

/** `account-list-keys.json` is there and cannot be used. The message names the file, never anything in it. */
export class ListKeysError extends Error {
  readonly code = "list_keys_unreadable";
  constructor(detail: string) {
    super(`${ACCOUNT_LIST_KEYS_FILE} cannot be used: ${detail}`);
    this.name = "ListKeysError";
  }
}

export const listKeysPath = (stateDir: string): string => join(stateDir, ACCOUNT_LIST_KEYS_FILE);

/**
 * The reset relay identity's own step: the keys of the PC this was are gone from the disk at once, whatever the file
 * holds, and the new identity makes its own at its first use. Never throws: a file that stays names another identity,
 * and is replaced then.
 */
export function forgetListKeys(stateDir: string): void {
  try { rmSync(listKeysPath(stateDir), { force: true }); }
  catch (error) { console.error(`[account] ${ACCOUNT_LIST_KEYS_FILE} could not be removed: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`); }
}

function parseFile(text: string): KeysFile {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ListKeysError("it is not JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ListKeysError("it does not hold this PC's list keys");
  const { v, server_id, signing, encryption, ...rest } = value as Record<string, unknown>;
  const secret = (text: unknown): text is string => typeof text === "string" && text.length === LIST_STORED_KEY_TEXT_LENGTH;
  if (v !== 1 || Object.keys(rest).length > 0 || typeof server_id !== "string" || !SERVER_ID_PATTERN.test(server_id) || !secret(signing) || !secret(encryption)) {
    throw new ListKeysError("it does not hold this PC's list keys");
  }
  return { v: 1, server_id, signing, encryption };
}

/** The keys a file's two secrets are. The one PKCS8 form is the same for a key that signs and one that agrees on a secret. */
async function importKeys(file: KeysFile): Promise<PcListKeys> {
  try {
    const signing = await readStoredEncryptionKey(file.signing);
    const encryption = await readStoredEncryptionKey(file.encryption);
    const privateKey = await crypto.subtle.importKey("pkcs8", new Uint8Array(fromBase64Url(file.signing)), ECDSA, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, PROBE));
    if (!await verifySignature(PROBE, signature, signing.key)) throw new ListKeysError("its signing key does not sign for its own public key");
    return { serverId: file.server_id, key: signing.key, privateKey, enc: encryption.key, encPrivateKey: encryption.privateKey };
  } catch (error) {
    if (error instanceof ListKeysError) throw error;
    if (error instanceof ListSealError || error instanceof DOMException) throw new ListKeysError("a key in it is not a P-256 private key");
    throw error;
  }
}

async function makeKeys(path: string, serverId: string): Promise<PcListKeys> {
  const signing = await generateStoredEncryptionKey();
  const encryption = await generateStoredEncryptionKey();
  const file: KeysFile = { v: 1, server_id: serverId, signing: signing.secret, encryption: encryption.secret };
  const keys = await importKeys(file);
  writePrivateState(path, file);
  return keys;
}

export class ListKeyStore {
  private readonly path: string;
  private held: PcListKeys | null = null;
  private turn: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) { this.path = listKeysPath(stateDir); }

  /**
   * The keys of the relay identity `serverId`: read from the file, made when there is none, and made anew when the
   * file holds another identity's (the old ones are gone with that write). Throws ListKeysError for a file that will
   * not read. One caller at a time, so two never make two pairs.
   */
  keysFor(serverId: string): Promise<PcListKeys> {
    const next = this.turn.then(() => this.load(serverId), () => this.load(serverId));
    this.turn = next.catch(() => undefined);
    return next;
  }

  private async load(serverId: string): Promise<PcListKeys> {
    if (this.held?.serverId === serverId) return this.held;
    let text: string | null;
    try { text = readFileSync(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ListKeysError("the file cannot be read");
      text = null;
    }
    const file = text === null ? null : parseFile(text);
    return this.held = file !== null && file.server_id === serverId ? await importKeys(file) : await makeKeys(this.path, serverId);
  }
}
