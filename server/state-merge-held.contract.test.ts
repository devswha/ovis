import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phone } from "./account/pairing.test-helpers.ts";
import { writePrivateState } from "./private-state.ts";
import { bounded, relayConnection, relayFixture } from "./relay/test-helpers.ts";

test("flag off: a held twin on a new key leaves the row on its admitted key", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-held-twin-"));
  try {
    const active = join(root, "active");
    const sibling = join(root, "sibling");
    mkdirSync(active);
    mkdirSync(sibling);
    const [admitted, incoming] = await Promise.all([phone(), phone()]);
    const id = "a".repeat(16);
    const gate = "2026-11-15T00:00:00.000Z";
    const row = { id, label: "Phone", role: "drive", token_hash: "a".repeat(64),
      relay_public_key: admitted.spki, created_at: gate, last_seen_at: null };
    writePrivateState(join(active, "devices.json"), { gate_closed_at: gate, devices: [row] });
    // The later link would take the incoming key in a merge without the held-twin exception.
    writePrivateState(join(sibling, "devices.json"), { gate_closed_at: gate, devices: [{ ...row,
      relay_public_key: incoming.spki, account: "acct_1", linked_at: "2026-11-15T01:00:00.000Z", held: "b".repeat(32) }] });

    const fixture = relayFixture(false, { stateDir: active, siblingStateDir: sibling, accountOpensAll: false, accountService: { url: "off" } });
    try {
      const refused = await relayConnection(fixture);
      expect(await bounded(Promise.race([refused.auth({ id, keys: incoming.keys, publicKey: incoming.spki }), refused.serverError]))).toBe("auth_failed");
      const allowed = await relayConnection(fixture);
      expect(await allowed.auth({ id, keys: admitted.keys, publicKey: admitted.spki })).toMatchObject({ device_id: id, role: "drive" });
      expect(fixture.app.context.services.devices.list(null).map(row => row.id)).toEqual([id]);
    } finally { fixture.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
