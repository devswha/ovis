/**
 * The fleet's witness (todo 31 of the relay-fleet plan): a record kept OUTSIDE the state folder, so a state folder put
 * back from a backup cannot carry its own proof of being current. `fleet-witness/<server_id>.json` under the user's
 * state home (`$XDG_STATE_HOME/ovis/`, default `~/.local/state/ovis/` on Linux, `~/Library/Application Support/ovis/`
 * on macOS, `%LOCALAPPDATA%\ovis\` on Windows; `OVIS_FLEET_WITNESS_DIR` names the folder itself), mode 0600 in a 0700
 * folder, written atomically and synced (server/private-state.ts) before the fleet store it speaks for.
 *
 * It holds `{v, server_id, generation, witness_key, removed: [{fingerprint, at}]}`. `generation` rises by one with
 * every removal, revocation, quarantine, retention sweep and slot replacement; `removed` keeps the fingerprint (the 32
 * hex digits of the machine id) of every key removed, revoked or replaced, at most MAX_REMOVED (a removal past it is
 * refused `witness_full`); `quarantined` keeps every key in quarantine, so a state folder from before a quarantine cannot
 * lift it unseen (it leaves the list only for `removed`, by the operator's release); `witness_key` is 32 random bytes made
 * once, the key of the FLEET_STATE tag a machine keeps (docs/fleet-link.md section 1). A file that is not exactly this is
 * refused loudly, never replaced.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writePrivateState } from "../private-state.ts";

export const MAX_REMOVED = 4096;

export interface RemovedKey { readonly fingerprint: string; readonly at: number }
export interface WitnessRecord {
  readonly v: 1;
  readonly server_id: string;
  readonly generation: number;
  /** base64url, 32 bytes */
  readonly witness_key: string;
  readonly removed: readonly RemovedKey[];
  readonly quarantined: readonly RemovedKey[];
}

export class WitnessError extends Error {
  constructor(readonly code: "witness_write_failed" | "witness_full" | "witness_unreadable", message: string) {
    super(message);
    this.name = "WitnessError";
  }
}

/** The folder of the witness files: OVIS_FLEET_WITNESS_DIR, else `fleet-witness` in the user's state home for Ovis. */
export function witnessDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const named = env["OVIS_FLEET_WITNESS_DIR"];
  if (named) return named;
  if (platform === "darwin") return join(home, "Library", "Application Support", "ovis", "fleet-witness");
  if (platform === "win32") return join(env["LOCALAPPDATA"] || join(home, "AppData", "Local"), "ovis", "fleet-witness");
  return join(env["XDG_STATE_HOME"] || join(home, ".local", "state"), "ovis", "fleet-witness");
}

/** The FLEET_STATE tag: HMAC-SHA256(witness_key, server_id (32 ASCII bytes) || generation (8 bytes, big-endian)). */
export function stateTag(witnessKey: Uint8Array, serverId: string, generation: number): Buffer {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(generation));
  return createHmac("sha256", witnessKey).update(Buffer.from(serverId, "ascii")).update(counter).digest();
}

function parse(text: string, serverId: string): WitnessRecord {
  const bad = (why: string): never => { throw new WitnessError("witness_unreadable", `the fleet witness ${why}`); };
  let value: unknown;
  try { value = JSON.parse(text); } catch { bad("is not JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad("is not an object");
  const v = value as Record<string, unknown>;
  if (v["v"] !== 1 || v["server_id"] !== serverId) bad("is not version 1 of this controller");
  const generation = v["generation"];
  if (!(typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0)) bad("has no generation");
  const key = v["witness_key"];
  if (typeof key !== "string" || Buffer.from(key, "base64url").length !== 32 || Buffer.from(key, "base64url").toString("base64url") !== key) bad("has no witness key");
  const keys = (field: "removed" | "quarantined"): RemovedKey[] => {
    const value = v[field] ?? (field === "quarantined" ? [] : undefined);
    if (!Array.isArray(value) || value.length > MAX_REMOVED) bad(`has no list of ${field} keys`);
    return (value as unknown[]).map((entry) => fingerprintAt(entry));
  };
  const fingerprintAt = (entry: unknown): RemovedKey => {
    const item = entry as Record<string, unknown>;
    if (typeof item !== "object" || item === null || typeof item["fingerprint"] !== "string" || !/^[0-9a-f]{32}$/.test(item["fingerprint"])
      || !(typeof item["at"] === "number" && Number.isSafeInteger(item["at"]) && item["at"] >= 0)) bad("lists a removed key that is not a fingerprint and a time");
    return { fingerprint: item["fingerprint"] as string, at: item["at"] as number };
  };
  return { v: 1, server_id: serverId, generation: generation as number, witness_key: key as string, removed: keys("removed"), quarantined: keys("quarantined") };
}

/** The witness of one controller (its server_id), read once and kept in memory; every change is written first. */
export class FleetWitness {
  readonly path: string;
  private record: WitnessRecord | null;

  constructor(readonly serverId: string, dir: string = witnessDir()) {
    this.path = join(dir, `${serverId}.json`);
    let text: string | undefined;
    try { text = readFileSync(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new WitnessError("witness_unreadable", `the fleet witness ${this.path} cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
    }
    this.record = text === undefined ? null : parse(text, serverId);
  }

  get exists(): boolean { return this.record !== null; }
  get generation(): number { return this.record?.generation ?? 0; }
  get removed(): readonly RemovedKey[] { return this.record?.removed ?? []; }
  isRemoved(fingerprint: string): boolean { return this.removed.some((entry) => entry.fingerprint === fingerprint); }
  get quarantined(): readonly RemovedKey[] { return this.record?.quarantined ?? []; }
  isQuarantined(fingerprint: string): boolean { return this.quarantined.some((entry) => entry.fingerprint === fingerprint); }

  /** The tag of `generation` for `serverId`, or undefined while the witness does not exist. */
  tag(serverId: string, generation: number): Buffer | undefined {
    return this.record ? stateTag(Buffer.from(this.record.witness_key, "base64url"), serverId, generation) : undefined;
  }

  /** Whether `tag` (base64url) is this witness's tag of `generation` for `serverId`. */
  verifies(serverId: string, generation: number, tag: string): boolean {
    const made = this.tag(serverId, generation);
    const given = Buffer.from(tag, "base64url");
    return made !== undefined && given.length === made.length && timingSafeEqual(made, given);
  }

  /**
   * Writes the next record: `generation` (at least the present one), `removed` with `add` appended and `drop` left out,
   * `quarantined` with `quarantine` appended and every key now removed left out. Past MAX_REMOVED keys in either list it
   * is refused `witness_full`; a write that fails is `witness_write_failed` and changes nothing.
   */
  write(change: { readonly generation?: number; readonly add?: readonly string[]; readonly drop?: readonly string[]; readonly quarantine?: readonly string[]; readonly at: number }): WitnessRecord {
    const before = this.record;
    const kept = (before?.removed ?? []).filter((entry) => !change.drop?.includes(entry.fingerprint));
    const added = (change.add ?? []).filter((fingerprint, index, all) => all.indexOf(fingerprint) === index && !kept.some((entry) => entry.fingerprint === fingerprint));
    const removed = [...kept, ...added.map((fingerprint) => ({ fingerprint, at: change.at }))];
    const gone = new Set(removed.map((entry) => entry.fingerprint));
    const held = (before?.quarantined ?? []).filter((entry) => !gone.has(entry.fingerprint));
    const quarantined = [...held, ...(change.quarantine ?? []).filter((fingerprint, index, all) => all.indexOf(fingerprint) === index && !gone.has(fingerprint) && !held.some((entry) => entry.fingerprint === fingerprint)).map((fingerprint) => ({ fingerprint, at: change.at }))];
    if (removed.length > MAX_REMOVED || quarantined.length > MAX_REMOVED) throw new WitnessError("witness_full", `the fleet witness lists ${MAX_REMOVED} keys; archive them before removing another`);
    const next: WitnessRecord = {
      v: 1, server_id: this.serverId, generation: Math.max(change.generation ?? before?.generation ?? 0, before?.generation ?? 0),
      witness_key: before?.witness_key ?? randomBytes(32).toString("base64url"), removed, quarantined,
    };
    try { writePrivateState(this.path, next); }
    catch (error) { throw new WitnessError("witness_write_failed", `the fleet witness ${this.path} cannot be written (${(error as NodeJS.ErrnoException).code ?? String(error)})`); }
    this.record = next;
    return next;
  }
}
