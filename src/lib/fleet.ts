/**
 * The Fleet screen's reads and writes (src/components/FleetView.tsx) over the fleet routes of docs/fleet-link.md:
 * `GET /api/fleet/machines`, `/invites` and `/batches` for any caller with full access, and the owner's writes (mint,
 * confirm, remove) with the app's own request header. Every answer is read as another version may send it: a field
 * missing or of the wrong kind drops that row, never the screen.
 */
import type { HealthAuth } from "../../shared/access.ts";
import { FLEET_CAUSE_SENTENCE, parseFleetCause } from "../../shared/fleet-cause.ts";
import type { FleetCause, FleetMachineRow } from "../../shared/fleet-cause.ts";
import { apiFetch } from "./api-request-id.ts";
import { errorFrom } from "./api.ts";
import { storedZip } from "./storedZip.ts";

export interface FleetBatchMachine { readonly machine_id: string; readonly slot: number | null; readonly name: string; readonly fingerprint: string }
/** A batch waiting for confirmation: what its Confirm sends back is the `count` and `digest` shown with it. */
export interface FleetBatch {
  readonly batch_id: string;
  readonly created_at: number;
  readonly count: number;
  readonly machines: readonly FleetBatchMachine[];
  readonly digest: string;
}
export interface FleetInvite { readonly id: string; readonly slot: number; readonly name: string; readonly batch_id: string; readonly exp: number; readonly state: "unused" | "used" | "expired" }
export interface FleetData {
  readonly machines: readonly FleetMachineRow[];
  readonly batches: readonly FleetBatch[];
  readonly invites: readonly FleetInvite[];
  /** The controller has no OVIS_TOKEN, so its fleet is held: every write answers `fleet_token_required`. */
  readonly held: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const whole = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const rows = <T>(value: unknown, read: (row: Record<string, unknown>) => T | null): T[] =>
  Array.isArray(value) ? value.flatMap((row) => { const found = isRecord(row) ? read(row) : null; return found === null ? [] : [found]; }) : [];

function machineRow(row: Record<string, unknown>): FleetMachineRow | null {
  if (!text(row["machine_id"]) || !text(row["name"]) || !text(row["fingerprint"])) return null;
  const state = row["state"];
  if (state !== "pending" && state !== "active" && state !== "quarantined" && state !== "revoked") return null;
  const cause: FleetCause | null = row["cause"] === null || row["cause"] === undefined ? null : parseFleetCause(row["cause"]);
  const route = row["route"] === "direct" || row["route"] === "relay" ? row["route"] : null;
  return {
    machine_id: row["machine_id"], name: row["name"], slot: whole(row["slot"]) ? row["slot"] : null, fingerprint: row["fingerprint"],
    batch_id: text(row["batch_id"]) ? row["batch_id"] : null, state, online: row["online"] === true, cause,
    message: cause === null ? null : FLEET_CAUSE_SENTENCE[cause], since: whole(row["since"]) ? row["since"] : 0,
    warnings: Array.isArray(row["warnings"]) ? [...new Set(row["warnings"].map(parseFleetCause))] : [],
    route, last_seen: whole(row["last_seen"]) ? row["last_seen"] : null,
  };
}

function batchRow(row: Record<string, unknown>): FleetBatch | null {
  if (!text(row["batch_id"]) || !whole(row["count"]) || !text(row["digest"])) return null;
  const machines = rows(row["machines"], (machine): FleetBatchMachine | null => text(machine["machine_id"]) && text(machine["name"]) && text(machine["fingerprint"])
    ? { machine_id: machine["machine_id"], name: machine["name"], fingerprint: machine["fingerprint"], slot: whole(machine["slot"]) ? machine["slot"] : null }
    : null);
  return { batch_id: row["batch_id"], created_at: whole(row["created_at"]) ? row["created_at"] : 0, count: row["count"], machines, digest: row["digest"] };
}

function inviteRow(row: Record<string, unknown>): FleetInvite | null {
  const state = row["state"];
  if (!text(row["id"]) || !whole(row["slot"]) || !text(row["name"]) || !text(row["batch_id"]) || !whole(row["exp"])) return null;
  if (state !== "unused" && state !== "used" && state !== "expired") return null;
  return { id: row["id"], slot: row["slot"], name: row["name"], batch_id: row["batch_id"], exp: row["exp"], state };
}

async function getFleet(url: string): Promise<Record<string, unknown>> {
  const response = await apiFetch(url, { cache: "no-store" });
  if (!response.ok) throw await errorFrom(url, response);
  const body: unknown = await response.json();
  return isRecord(body) ? body : {};
}

export async function fetchFleet(): Promise<FleetData> {
  const [machines, batches, invites] = await Promise.all([getFleet("/api/fleet/machines"), getFleet("/api/fleet/batches"), getFleet("/api/fleet/invites")]);
  return {
    machines: rows(machines["machines"], machineRow),
    batches: rows(batches["batches"], batchRow),
    invites: rows(invites["invites"], inviteRow),
    held: [machines, batches, invites].some((body) => body["fleet_state"] === "fleet_token_required"),
  };
}

async function write(url: string, method: "POST" | "DELETE", body?: unknown): Promise<unknown> {
  const response = await apiFetch(url, {
    method, cache: "no-store",
    headers: body === undefined ? { "x-herdr-update": "1" } : { "x-herdr-update": "1", "content-type": "application/json" },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  });
  if (!response.ok) throw await errorFrom(url, response);
  return response.json();
}

/** Activates exactly the machines the batch showed: its `count` and `digest` go back as they were read. */
export async function confirmFleetBatch(batch: Pick<FleetBatch, "batch_id" | "count" | "digest">): Promise<void> {
  await write(`/api/fleet/batches/${encodeURIComponent(batch.batch_id)}/confirm`, "POST", { count: batch.count, digest: batch.digest });
}

/** Removes a machine: its key is refused from then on and its session ends (the programs on it keep running). */
export async function removeFleetMachine(machineId: string): Promise<void> {
  await write(`/api/fleet/machines/${encodeURIComponent(machineId)}`, "DELETE");
}

export interface MintChoice { readonly count: number; readonly prefix: string; readonly life_s: number }
/** A minted batch as one archive: the invites' secrets exist only in `archive` until it is handed to the browser. */
export interface MintedArchive { readonly batchId: string; readonly count: number; readonly exp: number; readonly fileName: string; readonly archive: Uint8Array<ArrayBuffer> }

/**
 * Mints a batch and packs its invite files, one `<id>.json` each (as `ovis fleet invite --out` writes them), in one
 * stored zip. Nothing of the answer is kept beyond the archive.
 */
export async function mintFleetInvites(choice: MintChoice, at: Date = new Date()): Promise<MintedArchive> {
  const minted = await write("/api/fleet/invites", "POST", choice);
  if (!isRecord(minted) || !text(minted["batch_id"]) || !whole(minted["exp"]) || !Array.isArray(minted["invites"])) throw new Error("The server's answer holds no invites.");
  const encoder = new TextEncoder();
  const files = minted["invites"].flatMap((invite) => isRecord(invite) && text(invite["id"]) && /^[0-9a-f]{16}$/.test(invite["id"])
    ? [{ name: `${invite["id"]}.json`, data: encoder.encode(JSON.stringify(invite)) }] : []);
  const archive = storedZip(files, at);
  for (const file of files) file.data.fill(0);
  return { batchId: minted["batch_id"], count: files.length, exp: minted["exp"], fileName: `ovis-invites-${minted["batch_id"]}.zip`, archive };
}

/**
 * Whether this browser may change the fleet (the route table of todo 30: server/access.ts ownerAccess): signed in with
 * the role `drive`, not through an open LAN window or Portal. A watching device reads the lists only.
 */
export function fleetOwner(auth: HealthAuth | null): boolean {
  if (auth === null || !auth.authenticated) return false;
  return auth.role !== "watch" && auth.via !== "open" && auth.via !== "portal";
}

export function fleetStateWord(machine: Pick<FleetMachineRow, "state" | "online" | "cause">, t: (key: string) => string): string {
  if (machine.state === "revoked") return t("Removed from the fleet");
  if (machine.state === "quarantined") return t("On hold");
  if (machine.state === "pending") return t("Waiting for confirmation");
  if (machine.cause === "fleet_token_required") return t("Held");
  if (!machine.online) return machine.cause === "reconnecting" ? t("Reconnecting…") : t("Offline");
  return machine.cause === null ? t("Connected") : t("Needs attention");
}
