import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore, type StoredDevice } from "./devices.ts";
import { mergeRegistries } from "./state-merge.ts";
import { TAILNET_NODES_FILE, TAILNET_NODES_MAX, TAILNET_PROMPT_MS, TailnetNodes, tailnetNodeGate } from "./tailnet-nodes.ts";

const phone = { id: "nPhone1CNTRL", hostname: "phone", login: "owner@example.com" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(now: () => number = Date.now) {
  const dir = mkdtempSync(join(tmpdir(), "astra-nodes-"));
  dirs.push(dir);
  const nodes = new TailnetNodes(dir, null, now);
  const rows = new DeviceStore(dir);
  rows.attachTailnetNodes(nodes);
  const pair = () => {
    const paired = rows.pair(rows.startPairing().code, "Phone", "drive", Date.now(), [], false)!;
    return rows.match(paired.token)!;
  };
  return { dir, nodes, rows, pair, address: "100.64.0.9", owner: phone.login, whois: async () => phone };
}

it("retry after a failed local block cannot commit a non-durable removal", () => {
  const { dir, nodes, rows, pair } = fixture();
  const row = pair();
  rows.noteTailnetNode(row.id, phone.id);
  const path = join(dir, TAILNET_NODES_FILE);
  mkdirSync(path);
  expect(() => rows.revoke(row.id)).toThrow();
  expect(nodes.problem).not.toBeNull();
  rmSync(path, { recursive: true });
  try { rows.revoke(row.id); } catch { expect(rows.has(row.id)).toBe(true); return; }
  expect(rows.has(row.id)).toBe(false);
  expect(new TailnetNodes(dir).isBlocked(phone.id)).toBe(true);
});
