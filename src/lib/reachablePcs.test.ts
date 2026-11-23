import { describe, expect, it } from "bun:test";

import type { Machine } from "../../shared/machines.ts";
import type { SshCandidate } from "./api.ts";
import { reachablePcs, reachableState, type ReachableFacts } from "./reachablePcs.ts";

const config = (name: string, detail: string | null, tailnet?: string): SshCandidate => ({ name, destination: name, detail, source: "ssh_config", ...(tailnet === undefined ? {} : { tailnet }) });
const peer = (dnsName: string): SshCandidate => ({ name: dnsName.split(".")[0]!, destination: dnsName, detail: dnsName, source: "tailscale", tailnet: dnsName });

describe("reachablePcs", () => {
  it("makes one row of the config aliases the server resolved to one Tailscale PC, under Tailscale's machine name", () => {
    const rows = reachablePcs([
      config("mymac", "devswha@100.64.0.7", "macbookpro.tail0000.ts.net"),
      config("hosthatch", "root@hosthatch"),
      config("macbook", "devswha@macbookpro.tail0000.ts.net", "macbookpro.tail0000.ts.net"),
      peer("old-desktop.tail0000.ts.net"),
    ]);
    expect(rows.map(({ key, name, way, address, destination }) => ({ key, name, way, address, destination }))).toEqual([
      // the first alias in config order opens it, so that alias's User, key and port apply
      { key: "tailnet:macbookpro.tail0000.ts.net", name: "macbookpro", way: "tailscale", address: "macbookpro.tail0000.ts.net", destination: "mymac" },
      { key: "ssh:hosthatch", name: "hosthatch", way: "ssh_config", address: "root@hosthatch", destination: "hosthatch" },
      { key: "tailnet:old-desktop.tail0000.ts.net", name: "old-desktop", way: "tailscale", address: "old-desktop.tail0000.ts.net", destination: "old-desktop.tail0000.ts.net" },
    ]);
    expect(rows[0]!.found.map((pc) => pc.name)).toEqual(["mymac", "macbook"]);
  });

  it("keeps a Tailscale PC's own entry and a config alias of it as one row, opened by the alias", () => {
    const rows = reachablePcs([peer("winvm.tail0000.ts.net"), config("lab", "rise@winvm.tail0000.ts.net", "WinVM.tail0000.ts.net.")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "winvm", destination: "lab", tailnet: "winvm.tail0000.ts.net" });
  });

  it("never merges by name: two hosts of one HostName stay two rows, since Port or ProxyJump may part them", () => {
    const rows = reachablePcs([config("vm1", "me@localhost"), config("vm2", "me@localhost"), config("desk", null)]);
    expect(rows.map((row) => [row.name, row.address])).toEqual([["vm1", "me@localhost"], ["vm2", "me@localhost"], ["desk", "desk"]]);
  });

  it("keeps two Tailscale PCs of one machine name apart: the resolved MagicDNS name decides", () => {
    const rows = reachablePcs([peer("box.tail0000.ts.net"), peer("box.tail1111.ts.net")]);
    expect(rows.map((row) => row.key)).toEqual(["tailnet:box.tail0000.ts.net", "tailnet:box.tail1111.ts.net"]);
  });
});

describe("reachableState", () => {
  const ssh = (destination: string, extra: Partial<Machine> = {}): Machine => ({ id: destination, name: destination, kind: "ssh", target: { destination }, enabled: true, state: "connected", error: null, snapshot: null, ...extra } as Machine);
  const relayPc = (serverId: string): Machine => ({ id: serverId, name: serverId, kind: "relay", relay: { server_id: serverId, relay: "wss://relay.test" }, enabled: true, state: "connected", error: null, snapshot: null } as Machine);
  const [mac] = reachablePcs([config("mymac", null, "macbookpro.ts.net"), config("macbook", null, "macbookpro.ts.net")]);
  const [hosthatch] = reachablePcs([config("hosthatch", "root@hosthatch")]);
  const facts = (extra: Partial<ReachableFacts> = {}): ReachableFacts => ({ machines: [], tailnet: { read: true, pcs: new Map() }, ...extra });

  it("is added when this app has a PC at any of its addresses, as Add would add it", () => {
    expect(reachableState(mac!, facts({ machines: [ssh("macbook")] }))).toBe("added");
    expect(reachableState(mac!, facts({ machines: [ssh("macbook", { target: { destination: "macbook", port: 2222 } })] }))).toBe("open");
    expect(reachableState(mac!, facts({ machines: [ssh("macbook", { target: { destination: "macbook", session: "work" } })] }))).toBe("open");
  });

  it("waits for the Tailscale PCs' Ovis to be known, then says an older one needs updating", () => {
    expect(reachableState(mac!, facts({ tailnet: { read: false, pcs: new Map() } }))).toBe("waiting");
    expect(reachableState(mac!, facts({ tailnet: { read: true, pcs: new Map([["macbookpro.ts.net", { outdated: true, server_id: null }]]) } }))).toBe("outdated");
    // a config host off the tailnet waits for nothing
    expect(reachableState(hosthatch!, facts({ tailnet: { read: false, pcs: new Map() } }))).toBe("open");
  });

  it("with the account's PCs given, says in-account by the PC's relay ID, from its Tailscale answer or from this app's PC at that address", () => {
    const probed = { read: true, pcs: new Map([["macbookpro.ts.net", { outdated: false, server_id: "srv_mac" }]]) };
    expect(reachableState(mac!, facts({ tailnet: probed, accountPcs: new Set(["srv_mac"]) }))).toBe("in-account");
    expect(reachableState(mac!, facts({ tailnet: probed, accountPcs: new Set(["srv_other"]) }))).toBe("open");
    expect(reachableState(hosthatch!, facts({ machines: [ssh("hosthatch", { server_id: "srv_hh" })], accountPcs: new Set(["srv_hh"]) }))).toBe("in-account");
    expect(reachableState(hosthatch!, facts({ machines: [ssh("hosthatch", { server_id: "srv_hh" })], accountPcs: new Set() }))).toBe("added");
    // a PC this app already has through the relay is not added a second time over SSH
    expect(reachableState(mac!, facts({ tailnet: probed, machines: [relayPc("srv_mac")], accountPcs: new Set() }))).toBe("added");
    // in the account comes first: an older Ovis there needs no update to be in it
    const old = { read: true, pcs: new Map([["macbookpro.ts.net", { outdated: true, server_id: "srv_mac" }]]) };
    expect(reachableState(mac!, facts({ tailnet: old, accountPcs: new Set(["srv_mac"]) }))).toBe("in-account");
  });

  it("without the account's PCs (the Tailscale tab) keeps to what this app has at that address", () => {
    const probed = { read: true, pcs: new Map([["macbookpro.ts.net", { outdated: false, server_id: "srv_mac" }]]) };
    expect(reachableState(mac!, facts({ tailnet: probed, machines: [relayPc("srv_mac")] }))).toBe("open");
  });
});
