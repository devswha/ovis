/**
 * The fleet tests' server (todo 60 of the relay-fleet plan): the fleet depends on a token (server/fleet/gate.ts), so a
 * test whose machines sign in, enrol or open forwards starts its controller with one, and its HTTP calls carry it.
 * A test of what happens without a token starts its server with `token: ""` itself (server/fleet/gate.contract.test.ts).
 */
import { relayFixture } from "../relay/test-helpers.ts";

/** A fixed test value, never a real token. */
export const FLEET_TEST_TOKEN = "fleet-test-token";
/** The header every HTTP call to a fleetTestServer sends. */
export const FLEET_TEST_AUTH = { authorization: `Bearer ${FLEET_TEST_TOKEN}` } as const;

/** relayFixture (port 0, a mkdtemp state folder) with the fleet test token unless `options.token` says otherwise. */
export function fleetTestServer(options: NonNullable<Parameters<typeof relayFixture>[1]> = {}): ReturnType<typeof relayFixture> {
  return relayFixture(false, { token: FLEET_TEST_TOKEN, ...options });
}
