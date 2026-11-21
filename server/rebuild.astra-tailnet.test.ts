import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "./devices.ts";
import { TAILNET_NODES_FILE, TailnetNodes, tailnetNodeGate } from "./tailnet-nodes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const phone = { id: "nPhone1CNTRL", hostname: "phone", login: "owner@example.com" };

function start(dir: string) {
  const nodes = new TailnetNodes(dir);
  const rows = new DeviceStore(dir);
  rows.attachTailnetNodes(nodes);
  return { nodes, rows };
}

for (const repair of ["rebuilt", "restored"] as const) {
  it(`a removal while the node list is unreadable still keeps the row's node out once the list is ${repair}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "astra-rebuild-"));
    dirs.push(dir);
    const before = start(dir);
    const paired = before.rows.pair(before.rows.startPairing().code, "Phone", "drive", Date.now(), [], false)!;
    const row = before.rows.match(paired.token)!;
    before.rows.noteTailnetNode(row.id, phone.id);
    const path = join(dir, TAILNET_NODES_FILE);
    writeFileSync(path, "not json", { mode: 0o600 });
    const broken = start(dir);
    expect(broken.nodes.problem).not.toBeNull();
    const removed = (() => { try { return broken.rows.revoke(row.id); } catch { return false; } })();
    if (!removed) { expect(broken.rows.has(row.id)).toBe(true); return; }
    if (repair === "rebuilt") rmSync(path);
    else writeFileSync(path, JSON.stringify({ v: 1, nodes: [] }), { mode: 0o600 });
    const after = start(dir);
    expect(after.nodes.problem).toBeNull();
    const first = await tailnetNodeGate({ level: "full", via: "tailscale", role: "drive", login: phone.login },
      { address: "100.64.0.9", owner: phone.login, nodes: after.nodes, rows: after.rows, whois: async () => phone });
    expect(first.access.level).toBe("none");
  });
}
