/**
 * An invite is a key (docs/account-list.md, "An invite is a key"). The device that makes one makes a P-256 key pair,
 * gives the account service the public key alone and writes the join line, which carries the private key
 * (shared/account-list-join.ts). The machine that joins proves it holds the line by signing the bytes below with that
 * key. So the account service never holds anything that redeems an invite or signs for one. No I/O; WebCrypto only.
 */
import { verifySignature } from "./account-list-entry.ts";
import { isAccountId, oneSpelling, readJoinLine, writeJoinLine } from "./account-list-join.ts";
import { toBase64Url } from "./relay-pair-sas.ts";

/** What a machine signs to redeem an invite starts with these bytes. */
export const INVITE_REDEEM_PREFIX = "ovis-invite-redeem/1";
/** A redeem signature as text: the base64url of `r || s`, 64 bytes, in its one spelling. */
export const INVITE_SIGNATURE_CHARS = 86;

/** What a redeem signature covers: the account the invite is for, the machine that joins, and the challenge it answers. */
export interface InviteRedeem {
  /** The account's id, as the join line names it. */
  readonly account: string;
  /** The machine's id: 32 of `0-9a-f`. */
  readonly server_id: string;
  /** The machine's relay key: 64 of `0-9a-f`. */
  readonly public_key: string;
  /** The id of the account service's challenge that the machine's own proof answers in the same request: 32 of `0-9a-f`. */
  readonly challenge_id: string;
}

export class InviteRedeemError extends Error {
  readonly code = "redeem_malformed";
  constructor(message: string) {
    super(message);
    this.name = "InviteRedeemError";
  }
}

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * The bytes a redeem signature is over: `ovis-invite-redeem/1`, then `account`, `server_id`, `public_key` and
 * `challenge_id` in that order, each as its length (4 bytes, big-endian) and its bytes. Every value is ASCII by its
 * form. Refuses `redeem_malformed` for a value out of its form, so two parties never sign or check other bytes than
 * these.
 */
export function inviteRedeemBytes(redeem: InviteRedeem): Uint8Array<ArrayBuffer> {
  const { account, server_id, public_key, challenge_id } = redeem;
  if (typeof account !== "string" || !isAccountId(account)) throw new InviteRedeemError("account is an account's id: 1 to 64 of A-Z a-z 0-9 _ -");
  if (typeof server_id !== "string" || !HEX_32.test(server_id)) throw new InviteRedeemError("server_id is 32 of 0-9a-f");
  if (typeof public_key !== "string" || !HEX_64.test(public_key)) throw new InviteRedeemError("public_key is 64 of 0-9a-f");
  if (typeof challenge_id !== "string" || !HEX_32.test(challenge_id)) throw new InviteRedeemError("challenge_id is 32 of 0-9a-f");
  const encoder = new TextEncoder();
  const parts = [account, server_id, public_key, challenge_id].map((value) => encoder.encode(value));
  const prefix = encoder.encode(INVITE_REDEEM_PREFIX);
  const bytes = new Uint8Array(prefix.length + parts.reduce((sum, part) => sum + 4 + part.length, 0));
  bytes.set(prefix);
  const view = new DataView(bytes.buffer);
  let offset = prefix.length;
  for (const part of parts) {
    view.setUint32(offset, part.length);
    bytes.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return bytes;
}

/**
 * The redeem signature, by the private key a join line carries (readJoinLine's `privateKey`): ECDSA P-256 with SHA-256
 * over inviteRedeemBytes, `r || s`, as 86 characters of base64url. Refuses `redeem_malformed` for a value out of its
 * form; whatever WebCrypto throws is a fault and goes up as it came.
 */
export async function signInviteRedeem(redeem: InviteRedeem, privateKey: CryptoKey): Promise<string> {
  const bytes = inviteRedeemBytes(redeem);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, bytes)));
}

/**
 * Whether `signature` is the redeem signature of the invite whose public key is `key` (a key as an entry spells one)
 * over these values. False for values out of their form, a signature that is not 86 characters in their one spelling,
 * an `r` or `s` outside 1 to n-1, a key that is no key or whose point is not on the curve, and a signature that does
 * not verify; a high `s` counts, as in an entry. Nothing here says whether the invite is open: the account service
 * looks it up by `key`.
 */
export async function verifyInviteRedeem(redeem: InviteRedeem, signature: unknown, key: unknown): Promise<boolean> {
  if (typeof signature !== "string" || signature.length !== INVITE_SIGNATURE_CHARS || typeof key !== "string") return false;
  const signed = oneSpelling(signature);
  if (signed === null) return false;
  let bytes: Uint8Array;
  try {
    bytes = inviteRedeemBytes(redeem);
  } catch (error) {
    if (error instanceof InviteRedeemError) return false;
    throw error;
  }
  return await verifySignature(bytes, signed, key);
}

/**
 * A new invite, made where the line is shown: a fresh key pair, the line that carries its private key, and its public
 * key, which is all the account service is given. The line is read again before it is returned, so `key` is the key
 * every reader of the line derives. Nothing keeps the private key but the line. Refuses as writeJoinLine does.
 */
export async function newInvite(service: string, account: string, list: string | null): Promise<{ readonly line: string; readonly key: string }> {
  const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
  const line = await writeJoinLine(service, account, list, pair.privateKey);
  return { line, key: (await readJoinLine(line)).key };
}
