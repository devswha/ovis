/**
 * Which PCs a relay lets in by their relay pass (shared/relay-pass.ts; README.md, "Relay pass"):
 * the mode, the account service's public keys and the server_ids taken off the relay. Both the
 * Cloudflare Worker and the Bun server read it from the same settings:
 *
 * - `RELAY_PASS_MODE`: `off` (the default: every PC, as before), `grace` (every PC, and the PC is
 *   told whether its pass holds and from when it will be needed) or `enforce` (a PC socket without
 *   a pass that holds closes 4402).
 * - `RELAY_PASS_ENFORCE_AT`: an ISO date; `grace` acts as `enforce` from then on.
 * - `RELAY_PASS_KEYS`: `kid:hex[,kid:hex]`, the Ed25519 public keys passes are checked with.
 * - `RELAY_PASS_REVOKED`: server_ids whose passes are refused, comma separated.
 */
import { RELAY_PASS_REQUIRED, checkRelayPass, importRelayPassKey } from "../shared/relay-pass.ts";

export type PassMode = "off" | "grace" | "enforce";

export interface PassPolicy {
  readonly mode: PassMode;
  /** when `grace` turns into `enforce` (ms), or null */
  readonly enforceAt: number | null;
  readonly keys: ReadonlyMap<string, CryptoKey>;
  readonly revoked: ReadonlySet<string>;
}

/** What the relay made of a PC socket's pass; `exp` (ms) only when it holds. */
export type PassState = "ok" | "missing" | "invalid" | "expired";
export interface PassResult { readonly state: PassState; readonly reason?: string; readonly exp?: number; readonly kid?: string }

export interface PassSettings {
  readonly RELAY_PASS_MODE?: string;
  readonly RELAY_PASS_ENFORCE_AT?: string;
  readonly RELAY_PASS_KEYS?: string;
  readonly RELAY_PASS_REVOKED?: string;
}

export const PASS_OFF: PassPolicy = { mode: "off", enforceAt: null, keys: new Map(), revoked: new Set() };

/** The mode at `now` (ms). */
export function passMode(policy: PassPolicy, now: number): PassMode {
  return policy.mode === "grace" && policy.enforceAt !== null && now >= policy.enforceAt ? "enforce" : policy.mode;
}

/** The policy the settings name; anything malformed throws, so a relay never runs with a policy it did not mean. */
export async function passPolicy(settings: PassSettings): Promise<PassPolicy> {
  const mode = settings.RELAY_PASS_MODE?.trim() || "off";
  if (mode !== "off" && mode !== "grace" && mode !== "enforce") throw new Error("RELAY_PASS_MODE must be off, grace or enforce");
  if (mode === "off") return PASS_OFF;
  const at = settings.RELAY_PASS_ENFORCE_AT?.trim();
  const enforceAt = at ? Date.parse(at) : null;
  if (enforceAt !== null && !Number.isFinite(enforceAt)) throw new Error("RELAY_PASS_ENFORCE_AT must be an ISO date");
  const keys = new Map<string, CryptoKey>();
  for (const entry of (settings.RELAY_PASS_KEYS ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const [kid, hex, extra] = entry.split(":");
    if (!kid || !/^[0-9a-f]{8}$/.test(kid) || !hex || extra !== undefined) throw new Error("RELAY_PASS_KEYS must be kid:hex pairs");
    keys.set(kid, await importRelayPassKey(hex));
  }
  if (keys.size === 0) throw new Error("RELAY_PASS_KEYS must name at least one key outside off");
  const revoked = new Set((settings.RELAY_PASS_REVOKED ?? "").split(",").map((part) => part.trim()).filter(Boolean));
  for (const id of revoked) if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("RELAY_PASS_REVOKED must list server_ids");
  return { mode, enforceAt, keys, revoked };
}

/** Checks the pass a PC socket of `serverId` came with, at `now` (ms). */
export async function checkPass(policy: PassPolicy, pass: string | null | undefined, serverId: string, now: number): Promise<PassResult> {
  if (policy.revoked.has(serverId)) return pass ? { state: "invalid", reason: "relay pass invalid" } : { state: "missing", reason: RELAY_PASS_REQUIRED };
  const check = await checkRelayPass(pass, policy.keys, serverId, Math.floor(now / 1000));
  if (check.ok) return { state: "ok", exp: check.payload.exp * 1000, kid: check.payload.kid };
  return { state: check.reason === RELAY_PASS_REQUIRED ? "missing" : check.reason === "relay pass expired" ? "expired" : "invalid", reason: check.reason };
}

/** The `relay_pass` field the relay adds to a PC's `sync` and a client's `assigned` outside `off`. */
export function passNotice(policy: PassPolicy, state: PassState): { state: PassState; enforce_at: string | null } {
  return { state, enforce_at: policy.enforceAt === null ? null : new Date(policy.enforceAt).toISOString() };
}
