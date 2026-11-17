import type { RelayDevice } from "../relay/device.ts";
import { enrollmentOf, type EnrollmentState } from "../relay/device.ts";
import { exportPublicKey } from "../../../shared/relay-e2ee.ts";
import { keyIdOf } from "../relay/shellState.ts";
import type { DirectoryPc } from "./service.ts";

function joinRoute(pc: DirectoryPc): MyPc["join"] {
  if (pc.public_key === null || pc.relay === null) return undefined;
  const bytes = Uint8Array.from(pc.public_key.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  const server_public_key = exportPublicKey(bytes);
  return keyIdOf(server_public_key) === pc.server_id ? { server_public_key, relay: pc.relay } : undefined;
}

export const NEW_PC_MS = 10 * 60_000;

export function newPcs(pcs: readonly MyPc[], now: number): MyPc[] {
  return pcs.filter((pc) => pc.state === "needs-approval" && pc.join !== undefined && pc.last_seen_at === null && pc.added_at !== null && now - Date.parse(pc.added_at) < NEW_PC_MS);
}

export const OFFLINE_AFTER_MS = 15 * 60_000;

export type MyPcState = "paired" | "needs-approval" | "offline" | "needs-update";

export interface MyPc {
  readonly server_id: string;
  readonly name: string;
  readonly state: MyPcState;
  readonly last_seen_at: string | null;
  readonly added_at: string | null;
  readonly listed: boolean;
  readonly paired: boolean;
  readonly linked: boolean;
  readonly enrollment?: EnrollmentState;
  readonly join?: { readonly server_public_key: string; readonly relay: string };
}

const ORDER: Record<MyPcState, number> = { paired: 0, "needs-update": 1, "needs-approval": 2, offline: 3 };

export function myPcs(directory: readonly DirectoryPc[], paired: readonly RelayDevice[], options: { now: number; outdated?: ReadonlySet<string>; accountKey?: string; account?: string }): MyPc[] {
  const listed = new Map(directory.map((pc) => [pc.server_id, pc]));
  const rows: MyPc[] = [];
  const stateOf = (serverId: string, isPaired: boolean, lastSeen: string | null): MyPcState => {
    if (options.outdated?.has(serverId)) return "needs-update";
    if (lastSeen !== null && options.now - Date.parse(lastSeen) > OFFLINE_AFTER_MS) return "offline";
    return isPaired ? "paired" : "needs-approval";
  };
  for (const device of paired) {
    if (device.device_id === null) continue;
    const entry = listed.get(device.server_id);
    listed.delete(device.server_id);
    const lastSeen = entry?.last_seen_at ?? null;
    const enrollment = enrollmentOf(device, options.account);
    rows.push({ server_id: device.server_id, name: device.name ?? device.server_id.slice(0, 8), state: stateOf(device.server_id, true, lastSeen), last_seen_at: lastSeen, added_at: entry?.added_at ?? null, listed: entry !== undefined, paired: true, linked: enrollment !== "pending" && enrollment !== "failed" && entry !== undefined && device.public_spki === options.accountKey && device.account !== undefined && device.account === (options.account ?? device.account), ...(enrollment ? { enrollment } : {}) });
  }
  for (const pc of listed.values()) {
    rows.push({ server_id: pc.server_id, name: pc.label, state: stateOf(pc.server_id, false, pc.last_seen_at), last_seen_at: pc.last_seen_at, added_at: pc.added_at, listed: true, paired: false, linked: false, ...(joinRoute(pc) ? { join: joinRoute(pc) } : {}) });
  }
  return rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}
