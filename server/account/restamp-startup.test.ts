import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../index.ts";
import { isJsonObject } from "../http.ts";
import { askRecovery } from "./recovery.ts";
import { RemovalEvidence } from "./removal-evidence.ts";
import { SafetyLog } from "./safety-log.ts";

const roots: string[] = [];
const servers = new Set<ReturnType<typeof createServer>>();
const posix = test.skipIf(process.platform === "win32");
const past = new Date(Date.now() - 86400000).toISOString();
const future = Date.now() + 3 * 86400000;
const folder = () => { const path = mkdtempSync(join(tmpdir(), "restamp-")); roots.push(path); return path; };
const put = (dir: string, file: string, value: unknown) => writeFileSync(join(dir, file), JSON.stringify(value), { mode: 0o600 });
const key = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const phone = () => ({ id: "1".repeat(16), role: "drive", label: "Phone", token_hash: "c".repeat(64), relay_public_key: key(), created_at: past, last_seen_at: null });
function start(stateDir: string, siblingStateDir?: string) {
  const server = createServer({ stateDir, ...(siblingStateDir ? { siblingStateDir } : {}), accountOpensAll: true, port: 0, hostname: "127.0.0.1", tailscaleOwner: null, sidecar: false, machines: false });
  servers.add(server);
  return { devices: server.context.services.devices, stop() { server.stop(); servers.delete(server); } };
}
afterEach(() => {
  for (const server of servers) server.stop();
  servers.clear();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

posix("ordinary boot keeps an independently readable sibling Lock on a later standalone start", () => {
  const active = folder(), sibling = folder();
  expect(SafetyLog.open(sibling).appendLock({ account: "test" }).outcome).toBe("applied");
  put(sibling, "devices.json", false);
  start(active, sibling).stop();
  start(active);
  expect(SafetyLog.open(active).state().locked).toBe(true);
});

posix("ordinary boot keeps an independently readable sibling Revoke on a later standalone start", () => {
  const active = folder(), sibling = folder(), row = phone();
  put(active, "devices.json", { gate_closed_at: past, devices: [row] });
  put(sibling, "devices.json", false);
  put(sibling, "account-tombstones.json", { v: 1, tombstones: [{ key: row.relay_public_key, account: "", removed_at: past, record_id: "local" }] });
  start(active, sibling).stop();
  expect(start(active).devices.hasKey(row.relay_public_key)).toBe(false);
});

posix("ordinary boot leaves a damaged sibling pending tombstone file to the sibling", () => {
  const active = folder(), sibling = folder(), row = phone();
  put(active, "devices.json", { gate_closed_at: past, devices: [row] });
  put(sibling, "devices.json", { gate_closed_at: past, devices: [row] });
  put(sibling, "account-tombstones.pending.json", false);
  const { devices } = start(active, sibling);
  expect(devices.accountError).toBeNull();
  expect(devices.hasKey(row.relay_public_key)).toBe(true);
});

posix("ordinary boot uses the surviving pairing time when twin rows disagree", () => {
  const active = folder(), sibling = folder(), row = phone();
  put(active, "devices.json", { gate_closed_at: past, devices: [row] });
  put(sibling, "devices.json", { gate_closed_at: past, devices: [{ ...row, created_at: new Date(future).toISOString() }] });
  const { devices } = start(active, sibling);
  expect(devices.list(null).find(d => d.id === row.id)?.created_at).toBe(past);
  expect(devices.accountError).toBeNull();
});

posix.each(["journal", "revoke", "lock"] as const)("restamp checks member accounts after ordinary %s removals", async cause => {
  const active = folder(), row = phone();
  RemovalEvidence.open(active, null).addRevoke(key(), null, future);
  const running = start(active);
  if (cause === "lock") expect(SafetyLog.open(active).appendLock({ account: "previous" }).outcome).toBe("applied");
  if (cause === "revoke") RemovalEvidence.open(active, null).addRevoke(row.relay_public_key, "previous", Date.now());
  if (cause === "journal") running.devices.journalEvent({ kind: "remove", how: "pc", key: row.relay_public_key, no: null, row: row.id, label: row.label, by: "pc", account: null });
  put(active, "devices.json", { gate_closed_at: past, devices: [{ ...row, account: "previous" }] });
  const preview = await askRecovery(active, { act: "restamp" });
  if (!isJsonObject(preview) || typeof preview.confirm !== "string") throw new Error(`Expected a preview: ${JSON.stringify(preview)}`);
  expect(await askRecovery(active, { act: "restamp", confirm: preview.confirm })).toMatchObject({ queued: true });
  running.stop();
  const applied = start(active);
  expect(applied.devices.accountError).toBeNull();
  expect(applied.devices.list(null).some(device => device.id === row.id)).toBe(false);
});


posix.each(["journal", "revoke", "lock"] as const)("restamp checks member accounts after ordinary %s removals on a cold start", async cause => {
  const active = folder(), row = phone();
  if (cause === "journal") {
    const first = start(active);
    first.devices.journalEvent({ kind: "remove", how: "pc", key: row.relay_public_key, no: null, row: row.id, label: row.label, by: "pc", account: null });
    first.stop();
  }
  if (cause === "lock") expect(SafetyLog.open(active).appendLock({ account: "previous" }).outcome).toBe("applied");
  if (cause === "revoke") RemovalEvidence.open(active, null).addRevoke(row.relay_public_key, "previous", Date.now());
  RemovalEvidence.open(active, null).addRevoke(key(), null, future);
  put(active, "devices.json", { gate_closed_at: past, devices: [{ ...row, account: "previous" }] });
  const running = start(active);
  const preview = await askRecovery(active, { act: "restamp" });
  if (!isJsonObject(preview) || typeof preview.confirm !== "string") throw new Error(`Expected a preview: ${JSON.stringify(preview)}`);
  expect(await askRecovery(active, { act: "restamp", confirm: preview.confirm })).toMatchObject({ queued: true });
  running.stop();
  const applied = start(active);
  expect(applied.devices.accountError).toBeNull();
  expect(applied.devices.list(null).some(device => device.id === row.id)).toBe(false);
});

posix("a Step 2 clock repair leaves a quarantined legacy pairing's time alone", async () => {
  const active = folder(), time = new Date(future).toISOString();
  put(active, "devices.json", { gate_closed_at: past, devices: [{ ...phone(), created_at: time }] });
  RemovalEvidence.open(active, null).addRevoke(key(), null, future + 1);
  const running = start(active);
  const preview = await askRecovery(active, { act: "restamp" });
  if (!isJsonObject(preview) || typeof preview.confirm !== "string") throw new Error("Expected a Step 2 repair");
  expect(await askRecovery(active, { act: "restamp", confirm: preview.confirm })).toMatchObject({ queued: true });
  running.stop();
  expect(start(active).devices.accountError).toBeNull();
  expect(JSON.parse(readFileSync(join(active, "devices.json"), "utf8")).devices).toMatchObject([{ created_at: time, untrusted_created_at: time }]);
});


posix("restamp leaves the approved journal alone when the bindings conflict on replay", async () => {
  const active = folder(), sibling = folder();
  RemovalEvidence.open(active, null).addRevoke(key(), null, future);
  const running = start(active, sibling);
  const preview = await askRecovery(active, { act: "restamp" });
  if (!isJsonObject(preview) || typeof preview.confirm !== "string") throw new Error("Expected a clock repair preview");
  expect(await askRecovery(active, { act: "restamp", confirm: preview.confirm })).toMatchObject({ queued: true });
  running.stop();
  for (const [dir, account, hex] of [[active, "first", "a"], [sibling, "second", "b"]] as const) {
    put(dir, "account-pc.json", { v: 1, next_admit: 1, binding: { account, bind_id: hex.repeat(32) }, clears: [], first: null, others_ever: true, gen: 0 });
  }
  const journal = join(active, "device-journal.json"), before = readFileSync(journal);
  expect(start(active, sibling).devices.accountError).toContain("two accounts");
  expect(readFileSync(journal).equals(before)).toBe(true);
});
