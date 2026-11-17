import { timingSafeEqual } from "node:crypto";

import { isLoopbackAddress } from "./access.ts";
import { PAGE_MEDIA_ROUTE } from "./file-view.ts";
import { badRequest, jsonResponse } from "./http.ts";

export const TOKEN_COOKIE = "ovis_token";
export const DEVICE_COOKIE = "ovis_device";
const LEGACY_TOKEN_COOKIE = "herdr_web_token";
const LEGACY_DEVICE_COOKIE = "herdr_web_device";

export function tokenCookie(cookies: Map<string, string>): string | undefined {
  return cookies.get(TOKEN_COOKIE) ?? cookies.get(LEGACY_TOKEN_COOKIE);
}

export function deviceCookieValue(cookies: Map<string, string>): string | undefined {
  return cookies.get(DEVICE_COOKIE) ?? cookies.get(LEGACY_DEVICE_COOKIE);
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export const CLEAR_LEGACY_TOKEN_COOKIE = clearCookie(LEGACY_TOKEN_COOKIE);
export const CLEAR_LEGACY_DEVICE_COOKIE = clearCookie(LEGACY_DEVICE_COOKIE);
export const COOKIE_MAX_AGE_SECONDS = 31536000;

const AUTH_FAILURE_BUDGET = 5;
const AUTH_BACKOFF_MS = 1_000;
const AUTH_BACKOFF_MAX_MS = 60_000;
export const AUTH_CLIENTS_MAX = 1024;
const authAttempts = new Map<string, { failures: number; until: number }>();
const BEARER_PREFIX = "bearer ";
const DEVICE_PREFIX = "device ";
const encoder = new TextEncoder();

export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!name) continue;
    try {
      cookies.set(name, decodeURIComponent(pair.slice(separator + 1).trim()));
    } catch (error) {
      if (error instanceof URIError) continue;
      throw error;
    }
  }
  return cookies;
}

function matches(candidate: string, token: string): boolean {
  const left = encoder.encode(candidate);
  const right = encoder.encode(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isAuthenticated(request: Request, token: string): boolean {
  if (token === "") return true;
  const cookie = tokenCookie(parseCookies(request.headers.get("cookie")));
  if (cookie !== undefined && matches(cookie, token)) return true;
  return bearerMatches(request, token);
}

/**
 * A paired device's own token sent as `Authorization: Device <token>`, in place of its cookie: a
 * script that paired for its token in JSON (#2744). Matched exactly as the cookie is, so the same
 * role, last-seen and revocation hold; it is never the shared token.
 */
export function deviceAuthorizationValue(request: Request): string | undefined {
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.slice(0, DEVICE_PREFIX.length).toLowerCase() !== DEVICE_PREFIX) return undefined;
  return authorization.slice(DEVICE_PREFIX.length) || undefined;
}

export function bearerMatches(request: Request, token: string): boolean {
  if (token === "") return false;
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) return false;
  return matches(authorization.slice(BEARER_PREFIX.length), token);
}

export function requiresAuth(pathname: string): boolean {
  if (pathname === "/ws") return true;
  if (!pathname.startsWith("/api/")) return false;
  if (PAGE_MEDIA_ROUTE.test(pathname)) return false;
  return pathname !== "/api/health" && pathname !== "/api/auth" && pathname !== "/api/devices/pair";
}

export function unauthorizedJson(reason: "other_user" | "pairing_required" | "token_required" = "token_required"): Response {
  if (reason === "other_user") return jsonResponse({ error: { code: "other_user", message: "this PC belongs to another Tailscale user" } }, 403);
  return jsonResponse({ error: { code: "unauthorized", message: reason === "pairing_required" ? "pair this device, or use the token" : "token required" } }, 401);
}

export function isSecureRequest(request: Request): boolean {
  if (request.headers.get("x-forwarded-proto") === "https") return true;
  return new URL(request.url).protocol === "https:";
}

function sessionCookie(token: string, secure: boolean): string {
  const attributes = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; ${attributes}${secure ? "; Secure" : ""}`;
}

export function deviceCookie(token: string, secure: boolean): string {
  return `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export const DEVICE_COOKIE_CLEARED = clearCookie(DEVICE_COOKIE);

export function noContent(...setCookies: string[]): Response {
  const headers = new Headers();
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 204, headers });
}

function authWaitLeft(key: string): number {
  const entry = authAttempts.get(key);
  const left = entry === undefined ? 0 : entry.until - Date.now();
  return left <= 0 ? 0 : Math.ceil(left / 1000);
}

/**
 * The address a budget is kept for. A proxy on this PC (`tailscale serve`, a local reverse
 * proxy) is the peer of every request it forwards, so without this every visitor would share
 * the one 127.0.0.1 budget and five wrong tries from anyone would lock the owner out. Such a
 * proxy appends the address it saw to X-Forwarded-For, so the last entry is its word; earlier
 * entries are whatever the client sent. A peer that is not loopback is never taken on its word.
 * A forwarded address is named `<address> via <peer>`: see `budgets`.
 */
export function authClient(peer: string | null, headers: Headers): string | null {
  if (peer === null || !isLoopbackAddress(peer)) return peer;
  const forwarded = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return forwarded ? `${forwarded} via ${peer}` : peer;
}

type Channel = "sign-in" | "presented";

const SHARED_FAILURES = AUTH_FAILURE_BUDGET * 10;
const SHARED_WINDOW_MS = 10 * 60_000;
const sharedFailures = new Map<string, number[]>();
export function sharedFailuresSize(): number {
  return sharedFailures.size;
}
const ADMITTED_FOR_MS = 30 * 24 * 60 * 60_000;
const admitted = new Map<string, number>();

function sharedKey(channel: Channel, client: string | null): string | null {
  const via = client?.lastIndexOf(" via ") ?? -1;
  return client === null || via < 0 ? null : `${channel} via ${client.slice(via + " via ".length)}`;
}

function sharedWaitLeft(channel: Channel, client: string | null): number {
  const key = sharedKey(channel, client);
  if (key === null) return 0;
  const at = admitted.get(client!);
  if (at !== undefined && Date.now() - at < ADMITTED_FOR_MS) return 0;
  const recent = (sharedFailures.get(key) ?? []).filter((time) => Date.now() - time < SHARED_WINDOW_MS);
  if (recent.length < SHARED_FAILURES) return 0;
  return Math.ceil((recent[recent.length - SHARED_FAILURES]! + SHARED_WINDOW_MS - Date.now()) / 1000);
}

function waitLeft(channel: Channel, client: string | null): number {
  if (client === null) return 0;
  return Math.max(authWaitLeft(`${channel} ${client}`), sharedWaitLeft(channel, client));
}

function recordFailure(channel: Channel, client: string | null): void {
  if (client === null) return;
  recordAuthFailure(`${channel} ${client}`, AUTH_FAILURE_BUDGET);
  const key = sharedKey(channel, client);
  if (key === null) return;
  const recent = (sharedFailures.get(key) ?? []).filter((time) => Date.now() - time < SHARED_WINDOW_MS);
  recent.push(Date.now());
  sharedFailures.delete(key);
  sharedFailures.set(key, recent.slice(-SHARED_FAILURES));
  trimSharedFailures();
}

function trimSharedFailures(): void {
  for (const [address, failures] of sharedFailures) {
    if (failures.every((time) => Date.now() - time >= SHARED_WINDOW_MS)) sharedFailures.delete(address);
  }
  if (sharedFailures.size <= AUTH_CLIENTS_MAX) return;
  while (sharedFailures.size > AUTH_CLIENTS_MAX) sharedFailures.delete(sharedFailures.keys().next().value!);
}

function admit(client: string | null): void {
  if (client === null) return;
  for (const channel of ["sign-in", "presented"] as const) authAttempts.delete(`${channel} ${client}`);
  admitted.delete(client);
  admitted.set(client, Date.now());
  if (admitted.size > AUTH_CLIENTS_MAX) admitted.delete(admitted.keys().next().value!);
}

export function presentedToken(request: Request, token: string, client: string | null): "none" | "match" | "wrong" | "held" {
  if (token === "") return "none";
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.slice(0, BEARER_PREFIX.length).toLowerCase() === BEARER_PREFIX;
  if (!bearer && tokenCookie(parseCookies(request.headers.get("cookie"))) === undefined) return "none";
  if (waitLeft("presented", client) > 0) return "held";
  if (!isAuthenticated(request, token)) return "wrong";
  admit(client);
  return "match";
}

export function recordPresentedTokenFailure(client: string | null): void {
  recordFailure("presented", client);
}

export function presentedTokenHeld(client: string | null): Response {
  return tooManyAttempts(waitLeft("presented", client));
}

function tooManyAttempts(wait: number): Response {
  return jsonResponse({ error: { code: "too_many_attempts", message: `too many wrong tokens: wait ${wait}s` } }, 429, { "retry-after": String(wait) });
}

function recordAuthFailure(client: string, budget: number): void {
  const failures = (authAttempts.get(client)?.failures ?? 0) + 1;
  const wait = failures < budget ? 0 : Math.min(AUTH_BACKOFF_MS * 2 ** (failures - budget), AUTH_BACKOFF_MAX_MS);
  authAttempts.set(client, { failures, until: wait === 0 ? 0 : Date.now() + wait });
  if (authAttempts.size <= AUTH_CLIENTS_MAX) return;
  for (const [address, entry] of authAttempts) {
    if (authAttempts.size <= AUTH_CLIENTS_MAX / 2) return;
    if (entry.until !== 0 && entry.until > Date.now()) continue;
    authAttempts.delete(address);
  }
  while (authAttempts.size > AUTH_CLIENTS_MAX) authAttempts.delete(authAttempts.keys().next().value!);
}

export function forgetAuthAttempts(): void {
  authAttempts.clear();
  sharedFailures.clear();
  admitted.clear();
}

export async function handleAuthRequest(request: Request, token: string, client: string | null = null): Promise<Response> {
  if (request.method === "DELETE") {
    return noContent(clearCookie(TOKEN_COOKIE), clearCookie(DEVICE_COOKIE), CLEAR_LEGACY_TOKEN_COOKIE, CLEAR_LEGACY_DEVICE_COOKIE);
  }
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST or DELETE");
  if (token === "") return noContent();
  const wait = waitLeft("sign-in", client);
  if (wait > 0) return tooManyAttempts(wait);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("invalid_json", "request body must be JSON");
  }
  if (typeof payload !== "object" || payload === null || !("token" in payload)) {
    return badRequest("missing_token", "token is required");
  }
  const offered = payload.token;
  if (typeof offered !== "string") return badRequest("missing_token", "token is required");
  const waitNow = waitLeft("sign-in", client);
  if (waitNow > 0) return tooManyAttempts(waitNow);
  if (!matches(offered, token)) {
    recordFailure("sign-in", client);
    return jsonResponse({ error: { code: "invalid_token", message: "token does not match" } }, 401);
  }
  admit(client);
  return noContent(sessionCookie(token, isSecureRequest(request)), CLEAR_LEGACY_TOKEN_COOKIE);
}
