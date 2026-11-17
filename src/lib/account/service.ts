import { accountLabel, accountOsOf, type AccountAsker, type AccountOs } from "../../../shared/account-asker.ts";
import type { AccountLimits } from "../../../shared/protocol.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { newRecordId, type AccountRecord } from "../../../shared/account-records.ts";
import { isWssOrigin } from "../../../shared/relay-offer.ts";
import { GLOBAL_APP } from "../../../shared/relay-regions.ts";
import type { AccountLock, AccountProvider, AccountSession, AccountStore } from "./store.ts";
import { ACCOUNT_PROVIDERS, accountLock } from "./store.ts";

export function accountServiceOf(document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }): string | null {
  const content = document.querySelector('meta[name="ovis-account-service"]')?.getAttribute("content");
  if (!content) return null;
  let url: URL;
  try { url = new URL(content); } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.origin : null;
}

export function shellAccountServiceOf(document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }, origin: string, nativeApp: boolean): string | null {
  return nativeApp || origin === GLOBAL_APP ? accountServiceOf(document) : null;
}

export function pcAccountServiceOf(document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }, secure: boolean): string | null {
  const content = document.querySelector('meta[name="ovis-pc-account-service"]')?.getAttribute("content");
  if (!secure || !content) return null;
  // new URL in a try: an older WebView has no URL.canParse
  try {
    const url = new URL(content);
    return url.protocol === "https:" ? url.origin : null;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export function accountProvidersOf(document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }): AccountProvider[] {
  const named = new Set((document.querySelector('meta[name="ovis-account-providers"]')?.getAttribute("content") ?? "").split(",").map((name) => name.trim()));
  const offered = ACCOUNT_PROVIDERS.filter((provider) => named.has(provider));
  return offered.length > 0 ? offered : ["github"];
}

export const DEVICE_PROVIDERS = ["github", "google"] as const;
export type DeviceProvider = (typeof DEVICE_PROVIDERS)[number];

export interface OfferedProviders {
  readonly providers: AccountProvider[];
  readonly device: DeviceProvider[];
  readonly page: DeviceProvider[];
}

export async function offeredProviders(service: string, fallback: readonly AccountProvider[], options: { fetch?: Fetch } = {}): Promise<OfferedProviders> {
  const before: OfferedProviders = { providers: [...fallback], device: ["github"], page: [] };
  let body: unknown;
  try {
    const response = await (options.fetch ?? fetch)(new URL("/v1/providers", service));
    if (!response.ok) return before;
    body = await response.json();
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) return before;
    throw error;
  }
  if (!isRecord(body) || !Array.isArray(body.providers) || !Array.isArray(body.device)) return before;
  const named = new Set<unknown>(body.providers);
  const providers = ACCOUNT_PROVIDERS.filter((provider) => named.has(provider));
  if (providers.length === 0) return before;
  const device = new Set<unknown>(body.device);
  const page = new Set<unknown>(Array.isArray(body.device_page) ? body.device_page : []);
  return {
    providers,
    device: DEVICE_PROVIDERS.filter((provider) => device.has(provider) && named.has(provider)),
    page: DEVICE_PROVIDERS.filter((provider) => page.has(provider) && named.has(provider)),
  };
}

export interface AccountIdentity {
  readonly provider: AccountProvider;
  readonly added_at: string;
}

const REFRESH_EARLY_MS = 60_000;

export class AccountServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AccountServiceError";
  }
}

export class SignedOutError extends Error {
  readonly code = "signed_out";
  constructor() {
    super("Sign in to your account again");
    this.name = "SignedOutError";
  }
}

export const UNNAMED_DEVICE = "Device";

export interface Admission extends AccountAsker { readonly key: string; readonly label: string; readonly server_id: string; readonly at: string }

export interface DirectoryPc {
  readonly server_id: string;
  readonly label: string;
  readonly added_at: string;
  readonly last_seen_at: string | null;
  readonly public_key: string | null;
  readonly relay: string | null;
}

type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

const SERVER_ID = /^[0-9a-f]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function failure(response: Response): Promise<AccountServiceError> {
  let code = "http_error";
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) && isRecord(body.error) ? body.error : null;
    if (typeof error?.code === "string" && /^[a-z_]{1,40}$/.test(error.code)) code = error.code;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return new AccountServiceError(response.status, code, `The account service answered ${response.status} (${code})`);
}

export function parseAccountLimits(value: unknown): AccountLimits | null {
  if (!isRecord(value)) return null;
  const { plan, pcs_max, pcs_used, data_cap_bytes, data_used_bytes, data_metering, until } = value;
  if (typeof plan !== "string" || plan.trim() === "") return null;
  if (typeof pcs_max !== "number" || !Number.isSafeInteger(pcs_max) || pcs_max < 0) return null;
  if (pcs_used !== undefined && pcs_used !== null && (typeof pcs_used !== "number" || !Number.isSafeInteger(pcs_used) || pcs_used < 0)) return null;
  if (data_cap_bytes !== undefined && data_cap_bytes !== null && (typeof data_cap_bytes !== "number" || !Number.isSafeInteger(data_cap_bytes) || data_cap_bytes < 0)) return null;
  if (data_used_bytes !== undefined && data_used_bytes !== null && (typeof data_used_bytes !== "number" || !Number.isSafeInteger(data_used_bytes) || data_used_bytes < 0)) return null;
  if (until !== undefined && until !== null && (typeof until !== "number" || !Number.isFinite(until))) return null;
  const metered = data_metering === undefined || data_metering === "on";
  return {
    plan: plan.trim().length > 32 ? `${plan.trim().slice(0, 31)}…` : plan.trim(),
    pcs_max,
    ...(typeof pcs_used === "number" ? { pcs_used } : {}),
    ...(typeof data_cap_bytes === "number" ? { data_cap_bytes } : {}),
    ...(metered && typeof data_used_bytes === "number" ? { data_used_bytes } : {}),
    ...(until !== undefined ? { until: until ?? null } : {}),
  };
}

function parsePc(value: unknown): DirectoryPc | null {
  if (!isRecord(value) || typeof value.server_id !== "string" || !SERVER_ID.test(value.server_id)) return null;
  if (typeof value.label !== "string" || typeof value.added_at !== "string") return null;
  if (value.last_seen_at !== null && typeof value.last_seen_at !== "string") return null;
  const public_key = typeof value.public_key === "string" && /^[0-9a-f]{64}$/.test(value.public_key) ? value.public_key : null;
  const relay = typeof value.relay === "string" && isWssOrigin(value.relay) ? value.relay : null;
  return { server_id: value.server_id, label: value.label, added_at: value.added_at, last_seen_at: value.last_seen_at, public_key, relay };
}

export function sessionOf(body: unknown, service: string, now: number): AccountSession {
  if (!isRecord(body)) throw new AccountServiceError(502, "invalid_answer", "The account service sent no sign-in");
  const { access_token, refresh_token, expires_in, account, provider } = body;
  if (typeof access_token !== "string" || access_token === "" || typeof refresh_token !== "string" || refresh_token === ""
    || typeof expires_in !== "number" || !(expires_in > 0) || typeof account !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(account)
    || !ACCOUNT_PROVIDERS.includes(provider as AccountProvider)) {
    throw new AccountServiceError(502, "invalid_answer", "The account service sent an incomplete sign-in");
  }
  return { service, account, provider: provider as AccountProvider, access_token, refresh_token, expires_at: now + expires_in * 1000, sign_in_id: newRecordId() };
}

function legacySignInId(refreshToken: string): string {
  return `saved-${bytesToHex(sha256(utf8ToBytes(refreshToken)).subarray(0, 16))}`;
}

export function sameSignIn(a: AccountSession, b: AccountSession): boolean {
  return a.refresh_token === b.refresh_token || (a.sign_in_id !== undefined && a.sign_in_id === b.sign_in_id);
}

export async function requestToken(service: string, grant: Record<string, string>, options: { fetch?: Fetch; now?: () => number; bearer?: string } = {}): Promise<AccountSession> {
  const now = options.now ?? Date.now;
  const response = await (options.fetch ?? fetch)(new URL("/v1/token", service), {
    method: "POST", headers: { "content-type": "application/json", ...(options.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` }) }, body: JSON.stringify(grant),
  });
  if (!response.ok) throw await failure(response);
  return sessionOf(await response.json(), service, now());
}

export interface AccountServiceOptions {
  readonly store: AccountStore;
  readonly fetch?: Fetch;
  readonly now?: () => number;
  readonly lock?: AccountLock;
  readonly signIn?: AccountSession;
}

export class AccountService {
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly lock: AccountLock;

  constructor(private readonly options: AccountServiceOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.lock = options.lock ?? accountLock;
  }

  async session(): Promise<AccountSession | undefined> {
    let seen: AccountSession | undefined;
    try {
      await this.options.store.update("session", (current) => {
        seen = current === undefined || current.sign_in_id !== undefined ? current : { ...current, sign_in_id: legacySignInId(current.refresh_token) };
        return seen;
      });
    } catch {
      return this.options.store.get("session");
    }
    return seen;
  }

  forSignIn(session: AccountSession): AccountService {
    return new AccountService({ ...this.options, signIn: session });
  }

  async listPcs(): Promise<DirectoryPc[]> {
    const body = await this.call("GET", "/v1/pcs");
    const pcs = isRecord(body) && Array.isArray(body.pcs) ? body.pcs : null;
    if (pcs === null) throw new AccountServiceError(502, "invalid_answer", "The account service sent no PC list");
    return pcs.map(parsePc).filter((pc): pc is DirectoryPc => pc !== null);
  }

  async putPc(serverId: string, entry: { label: string; public_key: string; relay: string }): Promise<void> {
    await this.call("PUT", `/v1/pcs/${serverId}`, entry);
  }

  async deletePc(serverId: string): Promise<void> {
    await this.call("DELETE", `/v1/pcs/${serverId}`);
  }

  async postAdmission(serverId: string, label: string, key: string, os: AccountOs | null = null): Promise<void> {
    await this.call("POST", "/v1/admissions", { server_id: serverId, label, key, ...(os === null ? {} : { os }) });
  }

  async recentAdmissions(): Promise<Admission[]> {
    const body = await this.call("GET", "/v1/admissions");
    const list = isRecord(body) && Array.isArray(body.admissions) ? body.admissions : [];
    return list.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.label !== "string" || typeof entry.server_id !== "string" || typeof entry.at !== "string") return [];
      const label = accountLabel(entry.label) || UNNAMED_DEVICE;
      const city = typeof entry.city === "string" ? accountLabel(entry.city) : "";
      const place = typeof entry.country === "string" && /^[A-Z]{2}$/.test(entry.country)
        ? { country: entry.country, city: city === "" ? null : city }
        : { country: null, city: null };
      return [{ key: entry.key, label, server_id: entry.server_id, at: entry.at, os: accountOsOf(entry.os), ...place }];
    });
  }

  async limits(): Promise<AccountLimits | null> {
    const body = await this.call("GET", "/v1/account/limits");
    return parseAccountLimits(body);
  }

  async identities(): Promise<AccountIdentity[]> {
    const body = await this.call("GET", "/v1/identities");
    const list = isRecord(body) && Array.isArray(body.identities) ? body.identities : [];
    return list.filter((entry): entry is AccountIdentity => isRecord(entry) && ACCOUNT_PROVIDERS.includes(entry.provider as AccountProvider)
      && typeof entry.added_at === "string")
      .map(({ provider, added_at }) => ({ provider, added_at }));
  }

  async addMethod(provider: AccountProvider, signIn: (linkToken: string, bearer: string) => Promise<AccountSession>): Promise<AccountSession> {
    const body = await this.call("POST", "/v1/identities/link", { provider });
    const linkToken = isRecord(body) && typeof body.link_token === "string" && body.link_token !== "" ? body.link_token : null;
    if (linkToken === null) throw new AccountServiceError(502, "invalid_answer", "The account service sent no link");
    const before = await this.session();
    if (before === undefined) return this.signedOut();
    const after = await signIn(linkToken, before.access_token);
    const end = (session: AccountSession, what: string) => this.fetch(new URL("/v1/signout", session.service), { method: "POST", headers: { authorization: `Bearer ${session.access_token}` } })
      .catch((error: unknown) => console.warn(`Ovis: ${what} was not ended at the account service`, error instanceof Error ? error.name : error));
    if (after.account !== before.account) {
      await end(after, "a sign-in for another account");
      throw new AccountServiceError(502, "invalid_answer", "The account service answered for another account");
    }
    const outcome = await this.lock(async () => {
      let result: "kept" | "moved-on" | "signed-out" = "signed-out";
      await this.options.store.update("session", (current) => {
        if (current?.refresh_token === before.refresh_token) { result = "kept"; return after; }
        if (current !== undefined && current.account === before.account) result = "moved-on";
        return current;
      });
      return result;
    });
    if (outcome === "signed-out") {
      await end(after, "a link that finished after a sign-out");
      throw new SignedOutError();
    }
    if (outcome === "moved-on") {
      await end(after, "a link's sign-in no tab keeps");
      return (await this.session()) ?? after;
    }
    await end(before, "the replaced sign-in");
    return after;
  }

  async removeIdentity(provider: AccountProvider): Promise<void> {
    await this.call("DELETE", `/v1/identities/${provider}`);
  }

  async deleteAccount(): Promise<void> {
    await this.call("DELETE", "/v1/account");
  }

  async postRecord(serverIds: readonly string[], record: AccountRecord): Promise<number> {
    if (serverIds.length === 0) return 0;
    const body = await this.call("POST", "/v1/records", { server_ids: serverIds, record });
    return isRecord(body) && typeof body.queued === "number" ? body.queued : 0;
  }

  async signOut(): Promise<void> {
    await this.lock(async () => {
      const stored = await this.session();
      if (stored === undefined) return;
      const from = this.options.signIn;
      const replaced = from !== undefined && !sameSignIn(stored, from);
      const session = replaced ? from : stored;
      let live = session;
      try {
        live = replaced || session.expires_at - REFRESH_EARLY_MS > this.now() ? session : await this.refreshed(session);
        const response = await this.fetch(new URL("/v1/signout", live.service), { method: "POST", headers: { authorization: `Bearer ${live.access_token}` } });
        if (!response.ok) throw await failure(response);
      } catch (error) {
        if (!(error instanceof SignedOutError)) throw error;
      } finally {
        if (!replaced) await this.options.store.update("session", (current) => current?.refresh_token === session.refresh_token || current?.refresh_token === live.refresh_token ? undefined : current);
      }
    });
  }

  private async signedOut(from?: AccountSession): Promise<never> {
    await this.options.store.update("session", (current) => from === undefined || current?.refresh_token === from.refresh_token ? undefined : current);
    throw new SignedOutError();
  }

  private async refreshed(from: AccountSession): Promise<AccountSession> {
    let next: AccountSession;
    try {
      next = await requestToken(from.service, { grant_type: "refresh_token", refresh_token: from.refresh_token }, { fetch: this.fetch, now: this.now });
    } catch (error) {
      if (error instanceof AccountServiceError && (error.status === 400 || error.status === 401)) return this.signedOut(from);
      throw error;
    }
    const carried: AccountSession = from.sign_in_id === undefined ? next : { ...next, sign_in_id: from.sign_in_id };
    let kept = false;
    await this.options.store.update("session", (current) => {
      kept = current?.refresh_token === from.refresh_token;
      return kept ? carried : current;
    });
    if (!kept) throw new SignedOutError();
    return carried;
  }

  private async fresh(stale?: string): Promise<AccountSession> {
    const foreign = (session: AccountSession | undefined): boolean => this.options.signIn !== undefined && (session === undefined || !sameSignIn(session, this.options.signIn));
    const session = await this.session();
    if (foreign(session)) throw new SignedOutError();
    if (session === undefined) return this.signedOut();
    if (stale === undefined && session.expires_at - REFRESH_EARLY_MS > this.now()) return session;
    return this.lock(async () => {
      const current = await this.session();
      if (foreign(current)) throw new SignedOutError();
      if (current === undefined) return this.signedOut();
      if (current.access_token !== (stale ?? session.access_token)) return current;
      return this.refreshed(current);
    });
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let stale: string | undefined;
    for (const retry of [false, true]) {
      const session = await this.fresh(stale);
      const response = await this.fetch(new URL(path, session.service), {
        method,
        headers: { authorization: `Bearer ${session.access_token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 401 && !retry) { stale = session.access_token; continue; }
      if (response.status === 401) return this.signedOut(session);
      if (!response.ok) throw await failure(response);
      return response.status === 204 ? null : response.json();
    }
    return this.signedOut();
  }
}
