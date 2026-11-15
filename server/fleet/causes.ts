/**
 * `GET /api/fleet/machines`: one row per machine of the store with its state, why it is not usable and since when
 * (shared/fleet-cause.ts). A cause is only ever what this controller observes:
 *
 * - `revoked`, `quarantined`, `pending_confirmation`: the store's state of the machine;
 * - `runtime_down`, `bridge_down`: the `health` of the machine's latest PIPE_ADVERT, while it is signed in;
 * - `clock_skew`: the advert's `now` against this controller's clock when that advert arrived, more than 5 minutes
 *   either way (a warning: it never refuses a sign-in or an enrolment; an old advert from a right clock never warns);
 * - `controller_limit`: a machine whose key verified and that this controller had no place for (OVIS_FLEET_MAX, or the
 *   relay room's fleet share), until it signs in; a machine the relay turned away before it got in is never heard of
 *   here and shows `offline` (its own `ovis-link status` says `relay busy`);
 * - `fleet_token_required`: every machine but a revoked or quarantined one while the fleet is held for want of a
 *   token (server/fleet/gate.ts);
 * - `reconnecting`: an active machine with no session that this controller expects back (server/fleet/sessions.ts
 *   RECONNECT_MS): its pending session was let go when its batch was confirmed, or this controller just started;
 * - `offline`: an active machine with no session and nothing else to say;
 * - the rest are set by the todo that observes them, through `Fleet.report`.
 *
 * The row names no key, token, bearer, forward port or socket path, and no invite: it is made of the store's public
 * fields and the fleet's observation (server/fleet/sessions.ts), which holds none of those.
 */
import { FLEET_CAUSE_KIND, FLEET_CAUSE_SENTENCE } from "../../shared/fleet-cause.ts";
import type { FleetCause, FleetMachineRow, FleetMachinesBody, FleetRouteErrorCode } from "../../shared/fleet-cause.ts";
import { FLEET_ROUTE_ERRORS } from "../../shared/fleet-cause.ts";
import { jsonResponse } from "../http.ts";
import { fleetStateField } from "./gate.ts";
import { groupedFingerprint } from "./invites.ts";
import type { Fleet } from "./sessions.ts";
import { FleetStoreError } from "./store.ts";
import type { FleetMachine } from "./store.ts";

/** How far a machine's clock may be from this controller's before its row carries `clock_skew`. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** The row of one machine of the store; the roster's row of the machine shows its cause too (server/machines.ts). */
export function row(machine: FleetMachine, fleet: Pick<Fleet, "observe"> & Partial<Pick<Fleet, "held">>, batchId: string | null = null): FleetMachineRow {
  const seen = fleet.observe(machine.machine_id);
  const warnings: FleetCause[] = [];
  let cause: FleetCause | null = null;
  let since = seen.changedAt;
  const stopped = (found: FleetCause, at: number) => { cause = found; since = at; };

  if (machine.state === "revoked") stopped("revoked", machine.updated_at);
  else if (machine.state === "quarantined") stopped("quarantined", machine.updated_at);
  // a fleet held for want of a token: nothing signs in until it is set (server/fleet/gate.ts)
  else if (fleet.held?.() === true) stopped("fleet_token_required", seen.changedAt);
  else if (machine.state === "pending") stopped("pending_confirmation", machine.updated_at);
  else {
    const held = seen.reported;
    if (seen.online) {
      if (seen.health?.runtime === "down") stopped("runtime_down", seen.healthSince ?? seen.changedAt);
      else if (seen.health?.bridge === "down") stopped("bridge_down", seen.healthSince ?? seen.changedAt);
      if (seen.clockSkewMs !== undefined && Math.abs(seen.clockSkewMs) > CLOCK_SKEW_MS) warnings.push("clock_skew");
      if (held) {
        if (FLEET_CAUSE_KIND[held.cause] === "warns") { if (!warnings.includes(held.cause)) warnings.push(held.cause); }
        else if (cause === null) stopped(held.cause, held.since);
      }
    } else if (held) stopped(held.cause, held.since);
    else if (seen.reconnecting === true) stopped("reconnecting", seen.changedAt);
    else stopped("offline", seen.changedAt);
  }

  const found = cause as FleetCause | null;
  return {
    machine_id: machine.machine_id, name: machine.name, slot: machine.slot, fingerprint: groupedFingerprint(machine.machine_id), batch_id: batchId,
    state: machine.state, online: seen.online,
    cause: found, message: found === null ? null : FLEET_CAUSE_SENTENCE[found], since, warnings,
    route: seen.route, last_seen: seen.lastSeen,
  };
}

/**
 * Every machine of the store as its row; throws the FleetStoreError of a store file that was refused. While the fleet is
 * held as rolled back (todo 31) every machine not revoked shows `restored`, and says whether the witness lists its key
 * as removed after the backup.
 */
export function fleetRows(fleet: Fleet, restore = fleet.restoreView()): FleetMachineRow[] {
  const machines = fleet.machines();
  fleet.forget(new Set(machines.map((machine) => machine.machine_id)));
  const batches = fleet.invites.batchOf();
  const marks = new Map(restore?.machines.map((machine) => [machine.machine_id, machine]));
  return machines.map((machine) => {
    const alerts = fleet.alerts(machine.machine_id);
    const made = { ...row(machine, fleet, batches.get(machine.machine_id) ?? null), ...(alerts ? { alerts: { count: alerts.count, last: alerts.last } } : {}) };
    if (!restore || machine.state === "revoked") return made;
    const mark = marks.get(machine.machine_id);
    return { ...made, cause: "restored", message: FLEET_CAUSE_SENTENCE.restored, removed_after_backup: mark?.removed_after_backup ?? false, quarantined_after_backup: mark?.quarantined_after_backup ?? false };
  });
}

function fail(code: FleetRouteErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return jsonResponse({ error: { code, message } }, FLEET_ROUTE_ERRORS[code], { "cache-control": "no-store", ...headers });
}

/** `/api/fleet/machines`. Callers are decided in dispatch.ts: the same as the PC list's (any signed-in access, a watching one too). */
export function handleFleetMachines(request: Request, fleet: Fleet): Response {
  if (request.method !== "GET") return fail("method_not_allowed", "Use GET to list the fleet's machines.", { allow: "GET" });
  try {
    const restore = fleet.restoreView();
    const body: FleetMachinesBody = {
      machines: fleetRows(fleet, restore), ...fleetStateField(fleet.stateDir, !fleet.held()),
      ...(restore ? { restore: { notice: restore.notice, reason: restore.reason, store_generation: restore.store_generation, witness_generation: restore.witness_generation, digest: restore.digest } } : {}),
    };
    return jsonResponse(body, 200, { "cache-control": "no-store" });
  } catch (error) {
    if (error instanceof FleetStoreError) return fail("fleet_store_unreadable", "The fleet's machine list cannot be read; mend or move it away.");
    throw error;
  }
}
