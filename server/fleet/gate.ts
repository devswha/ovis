/**
 * The fleet depends on a token (todo 60 of the relay-fleet plan; docs/fleet.md, "Where the controller runs"). Without
 * OVIS_TOKEN every loopback connection counts as this PC itself (server/access.ts decideAccess), so any local process,
 * or anyone who can forward a port to it, could mint invites, confirm machines or open them. So while no token is
 * configured the fleet is held: every fleet write (server/dispatch.ts), the owner-key step (server/fleet/cli.ts) and both
 * machine sign-in paths, AUTH and ENROLL (server/relay/session.ts), answer `fleet_token_required` and write nothing; no
 * machine forward opens (server/fleet/sessions.ts); the store refuses every change itself (FleetStore.holdWhile), so a
 * writer that is not HTTP (a sweep, a backfill) is held too; reads keep answering and say why. server/access.ts is not changed:
 * with a token it decides as it always did, a paired device included. A server whose fleet was never turned on
 * answers as before apart from those refusals, and logs nothing new.
 */
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

export const FLEET_TOKEN_REQUIRED = "fleet_token_required";

/** The marker `POST /api/fleet/enable` and the first mint write. */
const ENABLED_FILE = "enabled";

/**
 * Whether the fleet of `stateDir` was turned on: the marker, the owner key (`ovis-server fleet owner`, todo 30) or a
 * machine store exists. Read only; nothing is made.
 */
export function fleetEnabled(stateDir: string): boolean {
  const folder = join(stateDir, "fleet");
  return [ENABLED_FILE, "owner.json", "machines.json"].some((name) => existsSync(join(folder, name)));
}

/** Writes the marker of a fleet turned on (an empty file, mode 0600, in a 0700 folder); leaves an existing one alone. */
export function markFleetEnabled(stateDir: string): void {
  const folder = join(stateDir, "fleet");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  try { closeSync(openSync(join(folder, ENABLED_FILE), "wx", 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

/** The one startup line of a controller whose fleet is on and that has no token, or null (none for any other server). */
export function fleetHeldWarning(stateDir: string, tokenConfigured: boolean): string | null {
  if (tokenConfigured || !fleetEnabled(stateDir)) return null;
  return "The fleet is held: this server has no OVIS_TOKEN, so no machine signs in or enrols and no fleet change is made until it is set. Set OVIS_TOKEN and restart; the machines sign in again with no new invite.";
}

/** What the fleet's reads add while it is held, so the app and `ovis fleet list` can show why: nothing otherwise. */
export function fleetStateField(stateDir: string, tokenConfigured: boolean): { readonly fleet_state?: typeof FLEET_TOKEN_REQUIRED } {
  return !tokenConfigured && fleetEnabled(stateDir) ? { fleet_state: FLEET_TOKEN_REQUIRED } : {};
}
