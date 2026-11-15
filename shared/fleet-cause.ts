/**
 * Why a fleet machine is not usable: the closed set of causes (docs/fleet-link.md, "Causes shown on a machine row"),
 * and the one plain sentence of each. A cause travels as
 * its code, never as text: `GET /api/fleet/machines` carries `cause` beside the English sentence, and the app
 * translates by the sentence (src/lib/i18n/fleet.*.ts). A value an older or newer peer sends that is not in this set
 * reads as FLEET_CAUSE_FALLBACK, never as an error.
 *
 * Only the controller's own observations set a cause (server/fleet/causes.ts); a cause no code observes yet is still
 * in the set, so a later todo sets it through `Fleet.report` and every reader already knows it.
 */

export const FLEET_CAUSES = [
  "offline", "revoked", "quarantined", "pending_confirmation", "controller_limit", "relay_limit", "relay_unreachable",
  "version_mismatch", "runtime_down", "bridge_down", "disk_full", "update_failed", "clock_skew", "restored", "fleet_token_required",
  "reconnecting",
] as const;
export type FleetCause = (typeof FLEET_CAUSES)[number];

/**
 * What a reader that does not know a cause shows: the machine is not connected and nothing more is claimed.
 */
export const FLEET_CAUSE_FALLBACK: FleetCause = "offline";

/**
 * `stops`: the machine cannot be used while this holds. `warns`: it is connected and works, the row only says what needs
 * attention (a skewed clock never refuses anything: the handshake needs no clock).
 */
export const FLEET_CAUSE_KIND: Record<FleetCause, "stops" | "warns"> = {
  offline: "stops",
  revoked: "stops",
  quarantined: "stops",
  pending_confirmation: "stops",
  controller_limit: "stops",
  relay_limit: "stops",
  relay_unreachable: "stops",
  version_mismatch: "stops",
  runtime_down: "stops",
  bridge_down: "stops",
  disk_full: "warns",
  update_failed: "warns",
  clock_skew: "warns",
  restored: "stops",
  fleet_token_required: "stops",
  reconnecting: "stops",
};

/** One plain sentence per cause. The English is the i18n key: every sentence has a Korean, Japanese and Chinese entry. */
export const FLEET_CAUSE_SENTENCE: Record<FleetCause, string> = {
  offline: "This machine is not connected right now.",
  revoked: "This machine was removed from the fleet, so it cannot connect any more.",
  quarantined: "This machine is on hold because its key or invite was used twice. An operator has to release it.",
  pending_confirmation: "This machine is waiting for you to confirm it.",
  controller_limit: "This controller has no free place for this machine: its limit of machines, or the places its relay gives to machines, are all in use.",
  relay_limit: "The relay turned this machine away because it is busy or at its limit. The machine tries again later.",
  relay_unreachable: "The relay cannot be reached, so this machine cannot connect through it.",
  version_mismatch: "This machine runs a version of Ovis that does not work with this controller. Update it.",
  runtime_down: "The engine on this machine is not running or cannot be used.",
  bridge_down: "The Ovis server on this machine is not running.",
  disk_full: "This machine's disk is full.",
  update_failed: "The last update of this machine did not finish, so it still runs the old version.",
  clock_skew: "This machine's clock is more than 5 minutes off. It still works, but check its time.",
  restored: "This controller was restored from a backup, so machines wait until you confirm them again.",
  fleet_token_required: "This controller has no OVIS_TOKEN, so its fleet is held. Set OVIS_TOKEN and restart it; the machine signs in again by itself.",
  reconnecting: "This machine is reconnecting to this controller. It should be back in a moment.",
};

export function isFleetCause(value: unknown): value is FleetCause {
  return typeof value === "string" && (FLEET_CAUSES as readonly string[]).includes(value);
}

/** A cause from a value of another version, or FLEET_CAUSE_FALLBACK. */
export function parseFleetCause(value: unknown): FleetCause {
  return isFleetCause(value) ? value : FLEET_CAUSE_FALLBACK;
}

/** One row of `GET /api/fleet/machines`. */
export interface FleetMachineRow {
  readonly machine_id: string;
  readonly name: string;
  /** The invite slot it enrolled into, or null. */
  readonly slot: number | null;
  /** The first 32 hex digits of SHA-256 over its public key, in groups of four: what its batch's confirmation shows. */
  readonly fingerprint: string;
  /** The batch of the invite it enrolled through, or null. */
  readonly batch_id: string | null;
  /** The store's state of the machine. */
  readonly state: "pending" | "active" | "quarantined" | "revoked";
  /** Whether a session of the machine is signed in now. */
  readonly online: boolean;
  /** Why the machine is not usable, or null when it is connected and nothing stops it. */
  readonly cause: FleetCause | null;
  /** The English sentence of `cause`, for a client that does not translate; null with it. */
  readonly message: string | null;
  /** ms since the epoch: when the state, the session or the cause last changed as far as this controller knows. */
  readonly since: number;
  /** What needs attention on a machine that works (causes whose kind is `warns`). */
  readonly warnings: readonly FleetCause[];
  /** How its signed-in session reaches this controller: a direct carrier or the relay; null while it is not signed in. */
  readonly route: "direct" | "relay" | null;
  /**
   * ms since the epoch: when a session of it was last signed in (now while one is); null when none was since this
   * controller started, which keeps sessions in memory only.
   */
  readonly last_seen: number | null;
  /** Only while the fleet is held as rolled back (todo 31): the witness lists this key as removed after the backup. */
  readonly removed_after_backup?: boolean;
  /** Only while the fleet is held as rolled back: the witness holds this key in quarantine, which the backup does not show. */
  readonly quarantined_after_backup?: boolean;
  /**
   * Alerts raised for this machine since the controller started (a quarantine, or a silent second session of its key,
   * todo 31), with when the last came (ms since the epoch); absent when there was none. Todo 33 draws them.
   */
  readonly alerts?: { readonly count: number; readonly last: number };
}

/** While the controller holds its fleet as rolled back (todo 31): what the operator confirms, by its digest. */
export interface FleetRestoreNotice {
  /** "This controller's fleet records are older than its witness" */
  readonly notice: string;
  readonly reason: string;
  readonly store_generation: number | null;
  readonly witness_generation: number | null;
  /** what `POST /api/fleet/restore/confirm {digest}` sends back */
  readonly digest: string;
}

export interface FleetMachinesBody {
  readonly machines: readonly FleetMachineRow[];
  /** present only while the fleet is held as rolled back */
  readonly restore?: FleetRestoreNotice;
  /** Present only while a fleet that was turned on is held for want of OVIS_TOKEN (server/fleet/gate.ts). */
  readonly fleet_state?: "fleet_token_required";
}

/** The errors of the fleet routes: every one a code of this list and its status, in the uniform error body. */
export const FLEET_ROUTE_ERRORS = {
  invalid_request: 400,
  unknown_batch: 404,
  /** `DELETE /api/fleet/machines/<id>` of a machine the store does not hold */
  unknown_machine: 404,
  /** `POST /api/fleet/invites/withdraw` of an invite the store does not hold */
  unknown_invite: 404,
  /** `POST /api/fleet/slots/<slot>/release` of a slot no machine or invite has */
  unknown_slot: 404,
  /** a release of a slot that is not in quarantine */
  slot_not_quarantined: 409,
  /** a re-admission of a key that was not removed */
  not_removed: 409,
  /** a restore confirmation while the fleet is not held as rolled back */
  not_restored: 409,
  /** a restore confirmation whose digest is not the list's now */
  restore_changed: 409,
  /** the witness lists 4096 removed keys: archive them before removing another */
  witness_full: 409,
  method_not_allowed: 405,
  /** `GET /api/fleet/machines/<id>/native` asked by anyone but a process on the controller with its token (todo 32) */
  controller_only: 403,
  /** a batch whose machines changed since it was read: read it again before confirming */
  batch_changed: 409,
  too_many_invites: 409,
  /** no carrier a machine could reach: the relay is off */
  fleet_unavailable: 409,
  /** the fleet was not turned on: `ovis-server fleet owner` makes its owner key first */
  owner_key_missing: 409,
  /** the server has no OVIS_TOKEN, so the fleet is held: nothing was changed (server/fleet/gate.ts) */
  fleet_token_required: 409,
  /** the machine's runtime cannot be reached now; the error carries the `cause` its row shows (todo 32's native route) */
  machine_unreachable: 409,
  /** this controller has no Unix socket forward (Windows): no runtime command line reaches a machine from it */
  native_unavailable: 409,
  fleet_store_unreadable: 503,
  fleet_store_busy: 503,
  /** the fleet's witness (outside the state folder) cannot be written: nothing changed */
  witness_write_failed: 503,
} as const;
export type FleetRouteErrorCode = keyof typeof FLEET_ROUTE_ERRORS;
