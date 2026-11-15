/**
 * A machine's `fleet.json` (docs/fleet-link.md, FLEET_FILE; the link agent's reader is crates/fleet-link/src/fleet.rs),
 * read in TypeScript by the same rules, for the join step that writes it from an invite and for the vectors: the
 * pinned controller, its carriers, the owner key with the controller as a member it signed, the machine key file and,
 * until enrolment, the invite. A file that breaks a rule is refused whole with its code: `controller_key_mismatch`
 * (a server_id its key does not derive), `controller_not_member` (the owner key did not sign this controller as a member
 * that may open), else `invalid_fleet`.
 */
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { readRelayPace } from "./mux-ext.ts";
import type { RelayPace } from "./mux-ext.ts";
import { OwnerError, parseOwner } from "./owner.ts";
import type { OwnerBlock } from "./owner.ts";

export const MAX_FLEET_FILE_BYTES = 16 * 1024;
const MAX_DIRECT = 4;

export interface FleetFile {
  readonly v: 1;
  readonly controller: { readonly server_id: string; readonly server_public_key: string; readonly relay: string | null; readonly direct: readonly string[] };
  readonly owner: OwnerBlock;
  readonly machine_key_file: string;
  readonly invite?: { readonly id: string; readonly secret: string };
  /** The newest relay pace the controller sent (todo 37), written back by the agent: a cache, left out when it breaks a rule. */
  readonly relay_pace?: RelayPace;
}

export class FleetFileError extends Error {
  constructor(readonly code: "invalid_fleet" | "controller_key_mismatch" | "controller_not_member", message: string) {
    super(message);
    this.name = "FleetFileError";
  }
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function ipv4(text: string): number[] | undefined {
  return IPV4.test(text) ? text.split(".").map(Number) : undefined;
}
/** Private (RFC 1918, link-local), Tailscale (100.64.0.0/10) or loopback: where a direct carrier may be. */
function directAddress([a, b]: number[]): boolean {
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127 || (a === 100 && b! >= 64 && b! < 128);
}
function hostName(text: string): boolean {
  return text.length > 0 && text.length <= 253 && text.split(".").every((label) => /^[a-z0-9-]{1,63}$/.test(label) && !label.startsWith("-") && !label.endsWith("-"));
}
/** `<host>:<port>`, the port written out without a leading zero. */
function place(text: string): { host: string; port: number } | undefined {
  const at = text.lastIndexOf(":");
  if (at < 0) return undefined;
  const port = text.slice(at + 1);
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) return undefined;
  return { host: text.slice(0, at), port: Number(port) };
}
function relay(text: string): boolean {
  if (text.startsWith("wss://")) {
    const rest = text.slice(6);
    const where = rest.includes(":") ? place(rest) : { host: rest, port: 443 };
    if (!where) return false;
    const canonical = where.port === 443 ? where.host : `${where.host}:${where.port}`;
    return canonical === rest && hostName(where.host);
  }
  if (!text.startsWith("ws://")) return false;
  const where = place(text.slice(5));
  return where !== undefined && ipv4(where.host)?.[0] === 127;
}
function direct(text: string): boolean {
  if (!text.startsWith("ws://")) return false;
  const where = place(text.slice(5));
  if (!where) return false;
  const address = ipv4(where.host);
  return address ? directAddress(address) : hostName(where.host) && isIP(where.host) === 0;
}
const canonical64 = (text: unknown, bytes: number, url: boolean): text is string => {
  if (typeof text !== "string") return false;
  const decoded = Buffer.from(text, url ? "base64url" : "base64");
  return decoded.length === bytes && decoded.toString(url ? "base64url" : "base64") === text;
};

/** fleet.json's bytes as the link agent takes them, or FleetFileError naming why not. */
export function parseFleetFile(bytes: Uint8Array): FleetFile {
  const bad = (why: string): never => { throw new FleetFileError("invalid_fleet", `fleet.json ${why}`); };
  if (bytes.length > MAX_FLEET_FILE_BYTES) bad("is too large");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { bad("is not JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad("is not an object");
  const v = value as Record<string, unknown>;
  if (v["v"] !== 1) bad("is not version 1");
  const c = v["controller"];
  if (typeof c !== "object" || c === null || Array.isArray(c)) bad("has no controller");
  const controller = c as Record<string, unknown>;
  const serverId = controller["server_id"];
  if (typeof serverId !== "string" || !/^[0-9a-f]{32}$/.test(serverId)) bad("controller.server_id takes 32 hex digits");
  const key = controller["server_public_key"];
  if (!canonical64(key, 32, false)) bad("controller.server_public_key takes 32 bytes of base64");
  if (deriveServerId(Buffer.from(key as string, "base64")) !== serverId) throw new FleetFileError("controller_key_mismatch", "controller key mismatch");
  const relayText = controller["relay"] ?? null;
  if (relayText !== null && !(typeof relayText === "string" && relay(relayText))) bad("controller.relay is not a wss: origin");
  const list = controller["direct"] ?? [];
  if (!Array.isArray(list) || list.length > MAX_DIRECT || !list.every((entry) => typeof entry === "string" && direct(entry)) || new Set(list).size !== list.length) bad("controller.direct holds an address that is not a direct carrier");
  if (relayText === null && (list as unknown[]).length === 0) bad("names neither a relay nor a direct carrier");
  const pinned = { server_id: serverId as string, server_public_key: key as string, relay: relayText as string | null, direct: list as string[] };
  let owner: OwnerBlock;
  try { owner = parseOwner(v["owner"], pinned); }
  catch (error) {
    if (!(error instanceof OwnerError)) throw error;
    throw new FleetFileError(error.code === "controller_not_member" ? "controller_not_member" : "invalid_fleet", error.message);
  }
  const keyFile = v["machine_key_file"];
  if (typeof keyFile !== "string" || !isAbsolute(keyFile)) bad("machine_key_file is not an absolute path");
  const invite = v["invite"];
  if (invite !== undefined) {
    const i = invite as Record<string, unknown>;
    if (typeof invite !== "object" || invite === null || Array.isArray(invite) || typeof i["id"] !== "string" || !/^[0-9a-f]{16}$/.test(i["id"]) || !canonical64(i["secret"], 32, true)) {
      bad("invite takes an id of 16 hex digits and a secret of 32 bytes of base64url");
    }
  }
  let pace: RelayPace | undefined;
  try { pace = v["relay_pace"] === undefined ? undefined : readRelayPace(v["relay_pace"]); } catch { pace = undefined; }
  return {
    v: 1, controller: pinned, owner, machine_key_file: keyFile as string,
    ...(invite === undefined ? {} : { invite: { id: (invite as { id: string }).id, secret: (invite as { secret: string }).secret } }),
    ...(pace === undefined ? {} : { relay_pace: pace }),
  };
}
