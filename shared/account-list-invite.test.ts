import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INVITE_REDEEM_PREFIX, INVITE_SIGNATURE_CHARS, InviteRedeemError, inviteRedeemBytes, newInvite, signInviteRedeem, verifyInviteRedeem, type InviteRedeem } from "./account-list-invite.ts";
import { isListKeyEncoding, isListPoint } from "./account-list-entry.ts";
import { JoinLineError, readJoinLine } from "./account-list-join.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const SERVICE = "https://accounts.ovis.test";
const DIR = join(import.meta.dir, "account-list-vectors", "invite");

interface KeyPair { readonly pkcs8: string; readonly spki: string }
interface InviteVector {
  readonly name: string;
  readonly keys: Readonly<Record<string, KeyPair>>;
  readonly line: string;
  readonly key: string;
  readonly redeem: InviteRedeem;
  readonly bytes?: string;
  readonly bytes_hex?: string;
  readonly signature: string;
  readonly expect: { readonly verifies: boolean };
}
const vectors = readdirSync(DIR).filter((file) => file.endsWith(".json")).sort()
  .map((file) => JSON.parse(readFileSync(join(DIR, file), "utf8")) as InviteVector);
const good = vectors.find((vector) => vector.name === "redeem");
if (!good) throw new Error("invite/redeem.json is missing");
const REDEEM = good.redeem;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
/** The bytes as this test writes them, with no part of the file under test: the tag, then each value after its length. */
function written(values: readonly string[]): Uint8Array {
  const parts: number[] = [...Buffer.from("ovis-invite-redeem/1", "ascii")];
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    parts.push((bytes.length >>> 24) & 0xff, (bytes.length >>> 16) & 0xff, (bytes.length >>> 8) & 0xff, bytes.length & 0xff, ...bytes);
  }
  return Uint8Array.from(parts);
}
const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
const malformed = (run: () => unknown): string | null => {
  try {
    run();
  } catch (error) {
    if (error instanceof InviteRedeemError) return error.code;
    throw error;
  }
  return null;
};

describe("the vectors of invite/", () => {
  test("names: one redeem proof that verifies, its high-s twin, and each way one does not, none missing", () => {
    expect(vectors.map((vector) => vector.name)).toEqual(["redeem-high-s", "redeem-other-account", "redeem-other-challenge", "redeem-other-key",
      "redeem-other-relay-key", "redeem-other-server", "redeem-r-zero", "redeem-server-id-uppercase", "redeem-signature-85", "redeem-signature-padded",
      "redeem-signature-second-spelling", "redeem"]);
    expect(vectors.filter((vector) => vector.expect.verifies).map((vector) => vector.name)).toEqual(["redeem-high-s", "redeem"]);
    for (const vector of vectors) expect(Object.keys(vector.keys).every((name) => name.startsWith("TEST-ONLY-"))).toBe(true);
  });

  for (const vector of vectors) {
    test(vector.name, async () => {
      // The key is the one the line reads to: a machine sends what it derived, and the service looks the invite up by it.
      expect((await readJoinLine(vector.line)).key).toBe(vector.key);
      if (vector.bytes !== undefined) {
        const bytes = inviteRedeemBytes(vector.redeem);
        expect(toBase64Url(bytes)).toBe(vector.bytes);
        expect(hex(bytes)).toBe(vector.bytes_hex ?? "");
      }
      expect(await verifyInviteRedeem(vector.redeem, vector.signature, vector.key)).toBe(vector.expect.verifies);
    });
  }

  test("the high-s vector is the good one with s replaced by n-s: one proof has two signatures, and both count", () => {
    const high = vectors.find((vector) => vector.name === "redeem-high-s");
    if (!high) throw new Error("no redeem-high-s");
    const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const [low, other] = [fromBase64Url(good.signature), fromBase64Url(high.signature)];
    expect(hex(other.subarray(0, 32))).toBe(hex(low.subarray(0, 32)));
    expect(BigInt(`0x${hex(other.subarray(32))}`)).toBe(N - BigInt(`0x${hex(low.subarray(32))}`));
    expect(BigInt(`0x${hex(other.subarray(32))}`) > N / 2n).toBe(true);
  });
});

describe("the bytes a redeem signature is over", () => {
  test("the tag, then account, server_id, public_key and challenge_id, each after its length in 4 bytes", () => {
    expect(INVITE_REDEEM_PREFIX).toBe("ovis-invite-redeem/1");
    expect(hex(inviteRedeemBytes(REDEEM))).toBe(hex(written([REDEEM.account, REDEEM.server_id, REDEEM.public_key, REDEEM.challenge_id])));
    for (let index = 0; index < 50; index++) {
      const redeem = { account: `a${randomHex(index % 32)}`.slice(0, 1 + (index % 64)), server_id: randomHex(16), public_key: randomHex(32), challenge_id: randomHex(16) };
      const bytes = inviteRedeemBytes(redeem);
      expect(hex(bytes)).toBe(hex(written([redeem.account, redeem.server_id, redeem.public_key, redeem.challenge_id])));
      expect(bytes.length).toBe(20 + 4 * 4 + redeem.account.length + 32 + 64 + 32);
    }
  });

  test("the caller's object is read once: a getter that answers otherwise the second time changes nothing", () => {
    let reads = 0;
    const redeem = { ...REDEEM, get account() { reads++; return reads === 1 ? REDEEM.account : "other"; } };
    expect(hex(inviteRedeemBytes(redeem))).toBe(good.bytes_hex ?? "");
    expect(reads).toBe(1);
  });

  test("a value out of its form is refused, so no other bytes are ever signed or checked", () => {
    const cases: Partial<Record<keyof InviteRedeem, readonly unknown[]>> = {
      account: ["", "a".repeat(65), "a.b", "a b", "계정", 1, null, undefined],
      server_id: ["", REDEEM.server_id.slice(1), `${REDEEM.server_id}0`, REDEEM.server_id.toUpperCase(), `${REDEEM.server_id.slice(1)}g`, 1, null],
      public_key: ["", REDEEM.public_key.slice(1), `${REDEEM.public_key}0`, REDEEM.public_key.toUpperCase(), REDEEM.server_id, 1, null],
      challenge_id: ["", REDEEM.challenge_id.slice(1), `${REDEEM.challenge_id}0`, REDEEM.challenge_id.toUpperCase(), `${REDEEM.challenge_id}\n`, 1, null],
    };
    for (const [name, values] of Object.entries(cases)) {
      for (const value of values) {
        expect({ name, value, code: malformed(() => inviteRedeemBytes({ ...REDEEM, [name]: value } as InviteRedeem)) }).toEqual({ name, value, code: "redeem_malformed" });
      }
    }
    expect(malformed(() => inviteRedeemBytes(REDEEM))).toBeNull();
  });
});

describe("signing and checking a redeem", () => {
  test("the key a line carries signs, and only its public key verifies, for exactly the values it signed", async () => {
    const invite = await newInvite(SERVICE, REDEEM.account, null);
    const line = await readJoinLine(invite.line);
    const signature = await signInviteRedeem(REDEEM, line.privateKey);
    expect(signature.length).toBe(INVITE_SIGNATURE_CHARS);
    expect(await verifyInviteRedeem(REDEEM, signature, invite.key)).toBe(true);
    // Another invite's key, and each value changed by one character.
    expect(await verifyInviteRedeem(REDEEM, signature, good.key)).toBe(false);
    const flip = (text: string) => `${text.slice(0, -1)}${text.endsWith("0") ? "1" : "0"}`;
    for (const name of ["account", "server_id", "public_key", "challenge_id"] as const) {
      expect({ name, verifies: await verifyInviteRedeem({ ...REDEEM, [name]: flip(REDEEM[name]) }, signature, invite.key) }).toEqual({ name, verifies: false });
    }
    // Two values swapped where their forms allow it: the place of a value is signed too.
    expect(await verifyInviteRedeem({ ...REDEEM, server_id: REDEEM.challenge_id, challenge_id: REDEEM.server_id }, signature, invite.key)).toBe(false);
  });

  test("a signature made over other bytes with the same key is no redeem signature", async () => {
    const line = await readJoinLine(good.line);
    const sign = async (bytes: Uint8Array) => toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, line.privateKey, new Uint8Array(bytes))));
    const bytes = inviteRedeemBytes(REDEEM);
    expect(await verifyInviteRedeem(REDEEM, await sign(bytes), good.key)).toBe(true);
    // The values with no tag, with another tag, and with a tag that only starts the same.
    expect(await verifyInviteRedeem(REDEEM, await sign(bytes.subarray(INVITE_REDEEM_PREFIX.length)), good.key)).toBe(false);
    for (const tag of ["ovis-pc-add/1", "ovis-list/1", "ovis-invite-redeem/2", "ovis-invite-redeem/10"]) {
      const other = Uint8Array.from([...Buffer.from(tag, "ascii"), ...bytes.subarray(INVITE_REDEEM_PREFIX.length)]);
      expect({ tag, verifies: await verifyInviteRedeem(REDEEM, await sign(other), good.key) }).toEqual({ tag, verifies: false });
    }
  });

  test("checking never throws for what a request may hold: it is false", async () => {
    const signature = good.signature;
    for (const other of [undefined, null, 1, "", signature.slice(1), `${signature}A`, `${signature.slice(0, -1)}=`, `${signature.slice(0, -1)}+`, ` ${signature.slice(1)}`, [signature]]) {
      expect({ other, verifies: await verifyInviteRedeem(REDEEM, other, good.key) }).toEqual({ other, verifies: false });
    }
    for (const key of [undefined, null, 1, "", good.key.slice(1), `${good.key}A`, good.keys["TEST-ONLY-invite"]?.pkcs8, [good.key]]) {
      expect({ key, verifies: await verifyInviteRedeem(REDEEM, signature, key) }).toEqual({ key, verifies: false });
    }
    for (const redeem of [{ ...REDEEM, account: "" }, { ...REDEEM, server_id: "x" }, { ...REDEEM, public_key: REDEEM.server_id }, { ...REDEEM, challenge_id: undefined }]) {
      expect(await verifyInviteRedeem(redeem as InviteRedeem, signature, good.key)).toBe(false);
    }
  });

  test("a key whose point is not on the curve verifies nothing, and is told apart from a key before any invite is stored", async () => {
    // The good key with its Y changed: a key in its one spelling that names no point.
    const bytes = fromBase64Url(good.key);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    const offCurve = toBase64Url(bytes);
    expect(isListKeyEncoding(offCurve)).toBe(true);
    expect(isListPoint(offCurve)).toBe(false);
    expect(await verifyInviteRedeem(REDEEM, good.signature, offCurve)).toBe(false);
    expect(isListKeyEncoding(good.key) && isListPoint(good.key)).toBe(true);
  });

  test("signing refuses values out of their form before it asks the key for anything", async () => {
    const line = await readJoinLine(good.line);
    const refused = await signInviteRedeem({ ...REDEEM, server_id: "nope" }, line.privateKey).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(InviteRedeemError);
  });
});

describe("making an invite", () => {
  test("a new invite is a line and its public key: the line reads to that key, names what it was made for, and its secret signs for it", async () => {
    const list = "0f484e9226ad290aaac6dea9244aced4e2b7b97297ecd8d52d437a57c33e5383";
    for (const given of [null, list]) {
      const invite = await newInvite(SERVICE, "TEST-ONLY-account", given);
      expect(Object.keys(invite).sort()).toEqual(["key", "line"]);
      expect(isListKeyEncoding(invite.key) && isListPoint(invite.key)).toBe(true);
      const read = await readJoinLine(invite.line);
      expect({ service: read.service, account: read.account, list: read.list, key: read.key })
        .toEqual({ service: SERVICE, account: "TEST-ONLY-account", list: given, key: invite.key });
      const publicKey = await crypto.subtle.importKey("spki", fromBase64Url(invite.key) as Uint8Array<ArrayBuffer>, P256, false, ["verify"]);
      const signature = await crypto.subtle.sign(SIGN, read.privateKey, new Uint8Array([1, 2, 3]));
      expect(await crypto.subtle.verify(SIGN, publicKey, signature, new Uint8Array([1, 2, 3]))).toBe(true);
    }
  });

  test("every invite is another key", async () => {
    const keys = new Set<string>();
    for (let index = 0; index < 20; index++) keys.add((await newInvite(SERVICE, "TEST-ONLY-account", null)).key);
    expect(keys.size).toBe(20);
  });

  test("what no line may hold is refused as the line's writer refuses it", async () => {
    const reason = async (service: string, account: string, list: string | null) => {
      try {
        await newInvite(service, account, list);
      } catch (error) {
        if (error instanceof JoinLineError) return error.reason;
        throw error;
      }
      return "none";
    };
    expect(await reason("http://accounts.ovis.test", "TEST-ONLY-account", null)).toBe("service");
    expect(await reason(SERVICE, "", null)).toBe("account");
    expect(await reason(SERVICE, "TEST-ONLY-account", "")).toBe("list");
  });
});
