/**
 * The fleet's invite and batch routes (docs/fleet-link.md section 4). Who may call each is decided in dispatch.ts, by the
 * rule todo 30 of the relay-fleet plan states once: a read by any caller with full access, a watching device included;
 * a write by an owner only (server/access.ts ownerAccess), from this PC or through the relay, behind the app's own
 * request header; never a Portal visitor, an open LAN window or a machine session.
 *
 * - `POST /api/fleet/enable` `{}`: turns the fleet on (todo 60): writes `<stateDir>/fleet/enabled`, as the first mint
 *   does; it makes no owner key (its phrase never goes over HTTP: `ovis-server fleet owner`). Answers `{enabled: true}`.
 * - `POST /api/fleet/invites` `{count?, prefix?, life_s?, direct_hosts?}`: mints a batch; its answer holds the invite
 *   files, the only place an invite's secret ever goes.
 * - `GET /api/fleet/invites`: every invite still listed with its state; no secret, no key.
 * - `GET /api/fleet/batches`: each batch waiting for confirmation with its machines' fingerprints, count and digest.
 * - `POST /api/fleet/batches/<id>/confirm` `{count, digest}`: activates exactly the set that was shown.
 * - `DELETE /api/fleet/machines/<id>` (todo 31): revokes the machine: its key goes into the fleet's witness and is
 *   revoked in the store, which ends its live sessions (`auth_revoked`, server/relay/session.ts follows the store) and
 *   closes its forward, so it leaves the roster; its programs keep running on the machine. The revoked record stays as a
 *   tombstone; removing it again forgets the record, and the witness keeps the key refused.
 * - `POST /api/fleet/machines/<id>/readmit`: takes one removed key off the witness's list (after a restore).
 * - `POST /api/fleet/slots/<slot>/release`: the operator's release of a quarantined slot: its key is revoked, so the slot
 *   may be enrolled again (`ovis fleet invite --slots-from`).
 * - `POST /api/fleet/restore/confirm` `{digest}`: confirms the list shown while the fleet is held as rolled back.
 * - `POST /api/fleet/invites/withdraw` `{invite_id}` or `{batch_id}`: withdraws open invites.
 * Each of these is a fleet write (owner only, dispatch.ts); server/fleet/routes-access.contract.test.ts holds their rows.
 * - `GET /api/fleet/machines/<id>/native` (todo 32, slice 32-early-b): the
 *   path of the controller's Unix socket forward to the machine's runtime and the runtime's bearer from the machine's
 *   newest advert, `{machine_id, name, socket_path, credential, runtime_id, boot_id}`, uncached. Only for a process on
 *   this PC that presents the server token in its Authorization header, never the token cookie (dispatch.ts): the bearer is the runtime's owner credential, and the forward
 *   cannot present it for the caller (the runtime reads it from its own protocol's hello), so the command that runs
 *   the runtime gets it, by its environment only. A machine that cannot be reached now answers 409
 *   `machine_unreachable` with the `cause` and `message` its row shows (server/fleet/causes.ts); one that is signed in
 *   but advertises no runtime has the cause `runtime_down`.
 *
 * Every write answers 409 `fleet_token_required` and changes nothing while the server has no token (server/dispatch.ts,
 * server/fleet/gate.ts); the reads keep answering and then carry `fleet_state: "fleet_token_required"`.
 */
import { FLEET_CAUSE_SENTENCE, FLEET_ROUTE_ERRORS } from "../../shared/fleet-cause.ts";
import type { FleetCause, FleetRouteErrorCode } from "../../shared/fleet-cause.ts";
import { jsonResponse } from "../http.ts";
import { row } from "./causes.ts";
import { confirmRequest, FleetRouteError, mintRequest, withdrawRequest } from "./invites.ts";
import type { InviteController } from "./invites.ts";
import { fleetStateField, markFleetEnabled } from "./gate.ts";
import type { Fleet } from "./sessions.ts";
import { FleetStoreError } from "./store.ts";

/** A body larger than this is refused before it is parsed. */
const MAX_BODY_BYTES = 4096;
const NO_STORE = { "cache-control": "no-store" };

function fail(code: FleetRouteErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return jsonResponse({ error: { code, message } }, FLEET_ROUTE_ERRORS[code], { ...NO_STORE, ...headers });
}

async function body(request: Request): Promise<unknown> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new FleetRouteError("invalid_request", "The request is too large.");
  if (text.trim() === "") return {};
  try { return JSON.parse(text); } catch { throw new FleetRouteError("invalid_request", "Send JSON."); }
}

/** Whether `pathname` is one of these routes. */
export const isFleetInviteRoute = (pathname: string): boolean =>
  pathname === "/api/fleet/enable" || pathname === "/api/fleet/invites" || pathname === "/api/fleet/batches" || /^\/api\/fleet\/batches\/[0-9a-f]{16}\/confirm$/.test(pathname);

const MACHINE_ROUTE = /^\/api\/fleet\/machines\/([0-9a-f]{32})$/;
const READMIT_ROUTE = /^\/api\/fleet\/machines\/([0-9a-f]{32})\/readmit$/;
const RELEASE_ROUTE = /^\/api\/fleet\/slots\/(0|[1-9]\d{0,4})\/release$/;
const RESTORE_ROUTE = "/api/fleet/restore/confirm";
const WITHDRAW_ROUTE = "/api/fleet/invites/withdraw";
/** Whether `pathname` is one machine's route or one of todo 31's lifecycle routes (all fleet writes). */
export const isFleetMachineRoute = (pathname: string): boolean =>
  MACHINE_ROUTE.test(pathname) || READMIT_ROUTE.test(pathname) || RELEASE_ROUTE.test(pathname) || pathname === RESTORE_ROUTE || pathname === WITHDRAW_ROUTE;

/** The routes of isFleetMachineRoute (callers are decided in dispatch.ts, as for every fleet write). */
export async function handleFleetMachineRoute(request: Request, pathname: string, fleet: Fleet): Promise<Response> {
  const only = (method: string, what: string) => request.method === method ? undefined : fail("method_not_allowed", `Use ${method} to ${what}.`, { allow: method });
  try {
    const machine = MACHINE_ROUTE.exec(pathname);
    if (machine) return only("DELETE", "remove a machine") ?? jsonResponse(fleet.removeMachine(machine[1]!), 200, NO_STORE);
    const readmit = READMIT_ROUTE.exec(pathname);
    if (readmit) return only("POST", "re-admit a removed key") ?? jsonResponse(fleet.readmit(readmit[1]!), 200, NO_STORE);
    const release = RELEASE_ROUTE.exec(pathname);
    if (release) {
      const slot = Number(release[1]);
      if (slot > 65535) return fail("unknown_slot", "No machine or invite has that slot.");
      return only("POST", "release a quarantined slot") ?? jsonResponse(fleet.release(slot), 200, NO_STORE);
    }
    if (pathname === RESTORE_ROUTE) {
      const refused = only("POST", "confirm a restored fleet");
      if (refused) return refused;
      const sent = await body(request) as { digest?: unknown };
      if (typeof sent.digest !== "string" || !/^[0-9a-f]{64}$/.test(sent.digest)) throw new FleetRouteError("invalid_request", "Send {digest} as the machine list showed it.");
      return jsonResponse(fleet.confirmRestore(sent.digest), 200, NO_STORE);
    }
    const refused = only("POST", "withdraw invites");
    if (refused) return refused;
    return jsonResponse(fleet.invites.withdraw(withdrawRequest(await body(request))), 200, NO_STORE);
  } catch (error) {
    if (error instanceof FleetRouteError) return fail(error.code, error.message);
    if (error instanceof FleetStoreError) {
      if (error.code === "fleet_token_required") return fail("fleet_token_required", "The fleet needs OVIS_TOKEN on this server: set it and restart Ovis. Nothing was changed.");
      if (error.code === "busy") return fail("fleet_store_busy", "The fleet's store is busy; try again.");
      return fail("fleet_store_unreadable", "The fleet's store cannot be read; mend or move it away.");
    }
    throw error;
  }
}

const NATIVE_ROUTE = /^\/api\/fleet\/machines\/([0-9a-f]{32})\/(native|bridge)$/;
/** Whether `pathname` is one machine's native or bridge route (the same callers: a process on this PC with the token). */
export const isFleetNativeRoute = (pathname: string): boolean => NATIVE_ROUTE.test(pathname);

/**
 * `/api/fleet/machines/<id>/native` and `/bridge`: GET only; callers are decided in dispatch.ts (a process on this PC
 * with the token in its Authorization header). `/bridge` (todo 32's `ovis start` and `ovis wait`) answers `{machine_id,
 * name, port, token}`: the controller's loopback TCP forward to the machine's bridge server and the bridge token of its
 * newest advert, which that forward and the bridge both ask for.
 */
export async function handleFleetNativeRoute(request: Request, pathname: string, fleet: Fleet): Promise<Response> {
  const [, machineId, endpoint] = NATIVE_ROUTE.exec(pathname)! as unknown as [string, string, "native" | "bridge"];
  if (request.method !== "GET") return fail("method_not_allowed", `Use GET to reach a machine's ${endpoint === "native" ? "runtime" : "bridge"}.`, { allow: "GET" });
  let machine;
  try { machine = fleet.store.get(machineId); }
  catch (error) {
    if (error instanceof FleetStoreError) return fail("fleet_store_unreadable", "The fleet's store cannot be read; mend or move it away.");
    throw error;
  }
  if (!machine) return fail("unknown_machine", "No machine has that id.");
  // a machine this controller expects back is waited for (RECONNECT_WAIT_MS): the credential is its new session's
  if (machine.state === "active" && fleet.reconnecting(machineId)) {
    try { await fleet.reconnected(machineId, request.signal); } catch { /* the caller went away: whatever is answered goes nowhere */ }
    // the record as it is now: one revoked or removed during the wait is answered as such
    try { machine = fleet.store.get(machineId); }
    catch (error) {
      if (error instanceof FleetStoreError) return fail("fleet_store_unreadable", "The fleet's store cannot be read; mend or move it away.");
      throw error;
    }
    if (!machine) return fail("unknown_machine", "No machine has that id.");
  }
  const shown = row(machine, fleet);
  const unreachable = (cause: FleetCause) =>
    jsonResponse({ error: { code: "machine_unreachable", message: FLEET_CAUSE_SENTENCE[cause], cause, since: shown.since } }, FLEET_ROUTE_ERRORS.machine_unreachable, NO_STORE);
  if (machine.state !== "active" || !fleet.online(machineId)) return unreachable(shown.cause ?? "offline");
  const advert = fleet.advert(machineId);
  if (endpoint === "bridge") {
    if (!advert?.endpoints.includes("bridge") || advert.bridge_token === undefined) return unreachable(shown.cause ?? "bridge_down");
    const forward = await fleet.forwardReady(machineId);
    if (!forward) return unreachable(shown.cause ?? "bridge_down");
    return jsonResponse({ machine_id: machine.machine_id, name: machine.name, port: forward.port, token: advert.bridge_token }, 200, NO_STORE);
  }
  if (!advert?.endpoints.includes("native") || advert.native_bearer === undefined) return unreachable(shown.cause ?? "runtime_down");
  const forward = await fleet.forwardReady(machineId);
  if (!forward?.socketPath) return fail("native_unavailable", "This controller has no socket forward to a machine's runtime (not on Windows).");
  return jsonResponse({
    machine_id: machine.machine_id, name: machine.name, socket_path: forward.socketPath, credential: advert.native_bearer,
    runtime_id: advert.runtime_id, boot_id: advert.boot_id,
  }, 200, NO_STORE);
}

/** One of the routes above; `describe` names this controller as an invite does (server/relay/service.ts fleetController). */
export async function handleFleetInviteRoute(request: Request, pathname: string, fleet: Fleet, describe: () => Promise<InviteController | null>): Promise<Response> {
  const held = fleetStateField(fleet.stateDir, !fleet.held());
  try {
    if (pathname === "/api/fleet/enable") {
      if (request.method !== "POST") return fail("method_not_allowed", "Use POST to turn the fleet on.", { allow: "POST" });
      markFleetEnabled(fleet.stateDir);
      return jsonResponse({ enabled: true }, 200, NO_STORE);
    }
    if (pathname === "/api/fleet/invites") {
      if (request.method === "GET") return jsonResponse({ invites: fleet.invites.list(), ...held }, 200, NO_STORE);
      if (request.method !== "POST") return fail("method_not_allowed", "Use GET to list invites or POST to mint them.", { allow: "GET, POST" });
      const minted = await fleet.invites.mint(mintRequest(await body(request)), describe);
      markFleetEnabled(fleet.stateDir);
      return jsonResponse(minted, 201, NO_STORE);
    }
    if (pathname === "/api/fleet/batches") {
      if (request.method !== "GET") return fail("method_not_allowed", "Use GET to list the batches waiting for confirmation.", { allow: "GET" });
      return jsonResponse({ batches: fleet.invites.batches(), ...held }, 200, NO_STORE);
    }
    if (request.method !== "POST") return fail("method_not_allowed", "Use POST to confirm a batch.", { allow: "POST" });
    const { count, digest } = confirmRequest(await body(request));
    const batchId = pathname.split("/")[4]!;
    return jsonResponse(await fleet.invites.confirm(batchId, count, digest), 200, NO_STORE);
  } catch (error) {
    if (error instanceof FleetRouteError) return fail(error.code, error.message);
    if (error instanceof FleetStoreError) {
      if (error.code === "fleet_token_required") return fail("fleet_token_required", "The fleet needs OVIS_TOKEN on this server: set it and restart Ovis. Nothing was changed.");
      return fail("fleet_store_unreadable", "The fleet's store cannot be read; mend or move it away.");
    }
    throw error;
  }
}
