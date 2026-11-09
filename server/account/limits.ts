/**
 * The account's limits from the account service (`GET /v1/account/limits`), read by the PC or
 * forwarded for a signed-in browser (`GET /api/account/limits`) and cached briefly in memory.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AccountLimits } from "../../shared/protocol.ts";
import { importPublicKey, importSecretKey } from "../../shared/relay-e2ee.ts";
import { answerServerChallenge } from "../../shared/relay-server-proof.ts";
import { isJsonObject } from "../http.ts";
import type { RelayIdentity } from "../relay/identity.ts";

/** How long a fetched limits answer is reused for the same credential or PC account. */
export const ACCOUNT_LIMITS_TTL_MS = 60_000;
const REQUEST_MS = 15_000;
const BEARER = /^(?:Bearer\s+)?([A-Za-z0-9._~+/-]+=*)$/;

export interface AccountLimitsCacheOptions {
  readonly service: string | Error;
  readonly identity: () => RelayIdentity | undefined;
  readonly account: () => string | null;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly now?: () => number;
}

/** Parses an account limits payload from the account service; null when the shape does not hold. */
export function parseAccountLimits(value: unknown): AccountLimits | null {
  if (!isJsonObject(value)) return null;
  const { plan, pcs_max, pcs_used, data_cap_bytes, data_used_bytes, data_metering, until } = value;
  if (typeof plan !== "string" || plan.trim() === "" || plan.length > 32) return null;
  if (typeof pcs_max !== "number" || !Number.isSafeInteger(pcs_max) || pcs_max < 0) return null;
  if (pcs_used !== undefined && pcs_used !== null && (typeof pcs_used !== "number" || !Number.isSafeInteger(pcs_used) || pcs_used < 0)) return null;
  if (data_cap_bytes !== undefined && data_cap_bytes !== null && (typeof data_cap_bytes !== "number" || !Number.isSafeInteger(data_cap_bytes) || data_cap_bytes < 0)) return null;
  if (data_used_bytes !== undefined && data_used_bytes !== null && (typeof data_used_bytes !== "number" || !Number.isSafeInteger(data_used_bytes) || data_used_bytes < 0)) return null;
  if (until !== undefined && until !== null && (typeof until !== "number" || !Number.isFinite(until))) return null;
  const metered = data_metering === undefined || data_metering === "on";
  return {
    plan: plan.trim(),
    pcs_max,
    ...(typeof pcs_used === "number" ? { pcs_used } : {}),
    ...(typeof data_cap_bytes === "number" ? { data_cap_bytes } : {}),
    ...(metered && typeof data_used_bytes === "number" ? { data_used_bytes } : {}),
    ...(until !== undefined ? { until: until ?? null } : {}),
  };
}

export class AccountLimitsReader {
  private readonly cache = new Map<string, { limits: AccountLimits | null; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<AccountLimits | null>>();
  private readonly now: () => number;

  constructor(private readonly options: AccountLimitsCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Reads the account's limits: with the caller's bearer token when presented, else with this PC's
   * relay identity and account. Returns null when signed out, unconfigured, or unsupported by the service.
   */
  async read(authorization: string | null): Promise<AccountLimits | null> {
    if (typeof this.options.service !== "string") return null;
    const token = authorization ? BEARER.exec(authorization.trim())?.[1] ?? null : null;
    const pcAccount = token === null ? this.options.account() : null;
    const identity = token === null ? this.options.identity() : undefined;
    const key = token !== null ? `token:${token}` : pcAccount !== null && identity ? `pc:${identity.server_id}:${pcAccount}` : null;
    if (key === null) return null;
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && now < cached.expiresAt) return cached.limits;
    const running = this.inflight.get(key);
    if (running) return running;
    const promise = (token !== null ? this.fetchWithToken(this.options.service, token) : this.fetchWithPcProof(this.options.service, identity!, pcAccount!))
      .then((limits) => {
        if (limits !== null) {
          if (this.cache.size >= 64) this.cache.clear();
          this.cache.set(key, { limits, expiresAt: this.now() + ACCOUNT_LIMITS_TTL_MS });
        }
        return limits;
      })
      .finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, promise);
    return promise;
  }

  private async fetchWithToken(service: string, token: string): Promise<AccountLimits | null> {
    const fetcher = this.options.fetch ?? ((request: Request) => fetch(request));
    try {
      const response = await fetcher(new Request(`${service}/v1/account/limits`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_MS),
        redirect: "manual",
      }));
      if (!response.ok) return null;
      return parseAccountLimits(await response.json());
    } catch { return null; }
  }

  private async fetchWithPcProof(service: string, identity: RelayIdentity, account: string): Promise<AccountLimits | null> {
    const fetcher = this.options.fetch ?? ((request: Request) => fetch(request));
    const signal = AbortSignal.timeout(REQUEST_MS);
    try {
      // First try GET /v1/account/limits with PC headers in case the service answers it directly
      const direct = await fetcher(new Request(`${service}/v1/account/limits`, {
        method: "GET",
        headers: { "x-ovis-server-id": identity.server_id, "x-ovis-account": account },
        signal,
        redirect: "manual",
      }));
      if (direct.ok) return parseAccountLimits(await direct.json());
      if (direct.status !== 401 && direct.status !== 403) return null;
      const publicKey = bytesToHex(importPublicKey(identity.public_key));
      const challenge = await fetcher(new Request(`${service}/v1/pc/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ server_id: identity.server_id, public_key: publicKey }),
        signal,
        redirect: "manual",
      }));
      if (!challenge.ok) return null;
      const { challenge_id: challengeId, frame } = await challenge.json() as { challenge_id?: unknown; frame?: unknown };
      const proof = answerServerChallenge(frame, importSecretKey(identity.secret_key), {
        server_id: identity.server_id, role: "account", connection_id: typeof challengeId === "string" ? challengeId : null,
      });
      if (!proof || typeof challengeId !== "string") return null;
      const response = await fetcher(new Request(`${service}/v1/account/limits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ server_id: identity.server_id, challenge_id: challengeId, proof, account }),
        signal,
        redirect: "manual",
      }));
      if (!response.ok) return null;
      return parseAccountLimits(await response.json());
    } catch { return null; }
  }
}
