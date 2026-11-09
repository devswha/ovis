import { describe, expect, it } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { exportPublicKey, exportSecretKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId, serverChallenge, verifyServerProof } from "../../shared/relay-server-proof.ts";
import type { RelayIdentity } from "../relay/identity.ts";
import { ACCOUNT_LIMITS_TTL_MS, AccountLimitsReader, parseAccountLimits } from "./limits.ts";

function makeIdentity(): { identity: RelayIdentity; publicKey: Uint8Array } {
  const keys = generateKeyPair();
  return {
    publicKey: keys.publicKey,
    identity: {
      v: 1,
      server_id: deriveServerId(keys.publicKey),
      public_key: exportPublicKey(keys.publicKey),
      secret_key: exportSecretKey(keys.secretKey),
    },
  };
}

describe("parseAccountLimits", () => {
  it("parses valid account limits and drops data_used_bytes when metering is off", () => {
    expect(parseAccountLimits({ plan: "personal", pcs_max: 3, data_cap_bytes: 5_000_000, data_used_bytes: 1_000, data_metering: "on" })).toEqual({
      plan: "personal", pcs_max: 3, data_cap_bytes: 5_000_000, data_used_bytes: 1_000,
    });
    expect(parseAccountLimits({ plan: "personal", pcs_max: 3, data_cap_bytes: 5_000_000, data_used_bytes: 1_000, data_metering: "off" })).toEqual({
      plan: "personal", pcs_max: 3, data_cap_bytes: 5_000_000,
    });
    expect(parseAccountLimits({ plan: "", pcs_max: 3 })).toBeNull();
    expect(parseAccountLimits({ plan: "personal", pcs_max: -1 })).toBeNull();
    expect(parseAccountLimits(null)).toBeNull();
  });
});

describe("AccountLimitsReader", () => {
  it("reads GET /v1/account/limits with a bearer token and caches the answer for ACCOUNT_LIMITS_TTL_MS", async () => {
    let now = 1_000_000;
    const fake = new FakeAccountService(() => now);
    const token = fake.issueToken("acct_1");
    fake.setLimits("acct_1", { plan: "personal", pcs_max: 3, data_cap_bytes: 5_000, data_used_bytes: 500, data_metering: "on" });
    const reader = new AccountLimitsReader({
      service: "https://account.test",
      identity: () => undefined,
      account: () => null,
      fetch: (req) => fake.fetch(req),
      now: () => now,
    });
    const first = await reader.read(token);
    expect(first).toEqual({ plan: "personal", pcs_max: 3, data_cap_bytes: 5_000, data_used_bytes: 500 });
    expect(fake.requests.filter((r) => r === "GET /v1/account/limits")).toHaveLength(1);

    // within TTL: cached
    now += ACCOUNT_LIMITS_TTL_MS - 1;
    expect(await reader.read(`Bearer ${token}`)).toEqual(first);
    expect(fake.requests.filter((r) => r === "GET /v1/account/limits")).toHaveLength(1);

    // past TTL: fetched again
    now += 2;
    fake.setLimits("acct_1", { plan: "personal", pcs_max: 7 });
    expect(await reader.read(token)).toEqual({ plan: "personal", pcs_max: 7 });
    expect(fake.requests.filter((r) => r === "GET /v1/account/limits")).toHaveLength(2);
  });

  it("falls back to PC challenge proof when no bearer token is given", async () => {
    const { identity, publicKey } = makeIdentity();
    let expectedProof: string | null = null;
    const reader = new AccountLimitsReader({
      service: "https://account.test",
      identity: () => identity,
      account: () => "acct_pc",
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/account/limits" && request.method === "GET") {
          return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
        }
        if (url.pathname === "/v1/pc/challenge" && request.method === "POST") {
          const body = await request.json() as { server_id: string; public_key: string };
          expect(body.server_id).toBe(identity.server_id);
          expect(body.public_key).toBe(bytesToHex(publicKey));
          const { expected, frame } = serverChallenge(publicKey, { server_id: identity.server_id, role: "account", connection_id: "ch_1" });
          expectedProof = expected;
          return new Response(JSON.stringify({ challenge_id: "ch_1", frame }), { status: 200 });
        }
        if (url.pathname === "/v1/account/limits" && request.method === "POST") {
          const body = await request.json() as { server_id: string; challenge_id: string; proof: string; account: string };
          expect(body.account).toBe("acct_pc");
          expect(verifyServerProof(body.proof, expectedProof!)).toBe(true);
          return new Response(JSON.stringify({ plan: "personal", pcs_max: 3, pcs_used: 1 }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      },
    });
    expect(await reader.read(null)).toEqual({ plan: "personal", pcs_max: 3, pcs_used: 1 });
  });

  it("returns null when signed out or when the service is off", async () => {
    const off = new AccountLimitsReader({ service: new Error("off"), identity: () => undefined, account: () => null });
    expect(await off.read("tok")).toBeNull();
    const signedOut = new AccountLimitsReader({ service: "https://account.test", identity: () => undefined, account: () => null });
    expect(await signedOut.read(null)).toBeNull();
  });
});
