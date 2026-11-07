import { describe, expect, it } from "bun:test";
import type { MyPc } from "../account/myPcs.ts";
import type { DashboardPc } from "./dashboard.ts";
import { dashboardModel, dashboardPcs, relayHost } from "./dashboard.ts";

function pc(server_id: string, state: DashboardPc["state"], relay: string | null = null, last_seen_at: string | null = null): DashboardPc {
  return {
    server_id, name: server_id, state, relay, last_seen_at, added_at: null,
    listed: true, paired: state === "paired", linked: false,
  };
}

describe("dashboardModel", () => {
  it("counts each PC state in its dashboard category", () => {
    const model = dashboardModel([
      pc("paired", "paired"), pc("approval", "needs-approval"),
      pc("update", "needs-update"), pc("offline", "offline"),
    ], { label: "Me" }, "wss://relay.ovis.sh");
    expect(model.counts).toEqual({ ready: 1, needsYou: 2, offline: 1 });
  });

  it("groups PCs by relay and orders hubs by descending PC count", () => {
    const global = "wss://relay.ovis.sh";
    const regional = "wss://relay-ap.ovis.sh";
    const model = dashboardModel([
      pc("c", "paired", regional), pc("a", "paired", global), pc("b", "offline", global),
    ], { label: "Me" }, global);
    expect(model.relays).toEqual([
      { origin: regional, regional: true, pcs: ["c"] },
      { origin: global, regional: false, pcs: ["a", "b"] },
    ]);
    expect(model.map.hubs.map((hub) => hub.origin)).toEqual([global, regional]);
  });

  it("places a PC without a relay under the default relay", () => {
    const model = dashboardModel([pc("a", "paired")], { label: "Me" }, "wss://relay.ovis.sh");
    expect(model.relays).toEqual([{ origin: "wss://relay.ovis.sh", regional: false, pcs: ["a"] }]);
  });

  it("returns zero counts and no relay groups for an empty list", () => {
    expect(dashboardModel([], { label: "Me" }, "wss://relay.ovis.sh")).toMatchObject({
      counts: { ready: 0, needsYou: 0, offline: 0 },
      relays: [],
      map: { hubs: [] },
    });
  });

  it("marks paired, unknown, and offline sightings", () => {
    const model = dashboardModel([
      pc("seen", "paired", null, "2026-11-07T00:00:00Z"),
      pc("never-seen", "paired"),
      pc("old", "offline", null, "2026-11-01T00:00:00Z"),
      pc("approval-seen", "needs-approval", null, "2026-11-07T00:00:00Z"),
      pc("approval-unknown", "needs-approval"),
    ], { label: "Me" }, "wss://relay.ovis.sh");
    expect(model.map.hubs[0]?.nodes.map((node) => [node.server_id, node.seen])).toEqual([
      ["seen", "lately"], ["never-seen", "unknown"], ["old", "stale"],
      ["approval-seen", "unknown"], ["approval-unknown", "unknown"],
    ]);
  });

  it("matches the four-PC relay homepage mockup", () => {
    const regional = "wss://relay-ap.ovis.sh";
    const global = "wss://relay.ovis.sh";
    const model = dashboardModel([
      pc("Desk PC", "paired", regional, "2026-11-07T00:00:00Z"),
      pc("MacBook", "paired", regional),
      pc("Mac mini", "needs-approval", regional, "2026-11-07T00:00:00Z"),
      pc("Home server", "offline", global, "2026-11-01T00:00:00Z"),
    ], { label: "Me" }, global);
    expect(model.counts).toEqual({ ready: 2, needsYou: 1, offline: 1 });
    expect(model.map.hubs.map((hub) => hub.origin)).toEqual([regional, global]);
    expect(model.map.hubs[0]?.nodes.map(({ server_id, seen }) => [server_id, seen])).toEqual([
      ["Desk PC", "lately"], ["MacBook", "unknown"], ["Mac mini", "unknown"],
    ]);
  });

  it("marks only configured regional relay origins as regional", () => {
    const model = dashboardModel([
      pc("regional", "paired", "wss://relay-ap.ovis.sh"),
      pc("self-hosted", "paired", "wss://relay.example.test"),
    ], { label: "Me" }, "wss://relay.ovis.sh");
    expect(model.relays.map(({ origin, regional }) => [origin, regional])).toEqual([
      ["wss://relay-ap.ovis.sh", true],
      ["wss://relay.example.test", false],
    ]);
  });

  it("names a relay by its host, and an origin that is not a URL as it is", () => {
    expect(relayHost("wss://relay-ap.ovis.sh")).toBe("relay-ap.ovis.sh");
    expect(relayHost("wss://relay.example:8443/path")).toBe("relay.example:8443");
    expect(relayHost("not a url")).toBe("not a url");
    // the map, the strip and the table name one origin alike: a default port is the same relay
    expect(relayHost("wss://relay.example:443")).toBe("relay.example");
  });

  it("preserves myPcs order for every PC needing attention", () => {
    const model = dashboardModel([
      pc("one", "needs-update"), pc("ready", "paired"), pc("two", "offline"), pc("three", "needs-approval"),
    ], { label: "Me" }, "wss://relay.ovis.sh");
    expect(model.attention).toEqual([
      { server_id: "one", reason: "needs-update" },
      { server_id: "two", reason: "offline" },
      { server_id: "three", reason: "needs-approval" },
    ]);
  });
});

describe("dashboardPcs", () => {
  const row = (server_id: string, state: MyPc["state"], extra: Partial<MyPc> = {}): MyPc => ({ server_id, name: server_id, state, last_seen_at: null, added_at: null, listed: false, paired: state === "paired", linked: false, ...extra });

  it("takes the directory's relay for a PC the account lists, its join route's for one this device is not paired with, and the pairing's for one paired without the account", () => {
    const pcs = dashboardPcs(
      [row("listed", "paired", { listed: true }), row("joinable", "needs-approval", { listed: true, join: { server_public_key: "k", relay: "wss://relay-ap.ovis.sh" } }), row("qr", "paired")],
      [{ server_id: "listed", relay: "wss://relay.old.example" }, { server_id: "qr", relay: "wss://relay.example" }],
      [{ server_id: "listed", relay: "wss://relay.ovis.sh" }, { server_id: "joinable", relay: "wss://relay-ap.ovis.sh" }],
    );
    expect(pcs.map(({ server_id, relay }) => [server_id, relay])).toEqual([["listed", "wss://relay.ovis.sh"], ["joinable", "wss://relay-ap.ovis.sh"], ["qr", "wss://relay.example"]]);
    // the rows keep everything myPcs said of them
    expect(pcs[0]).toMatchObject({ state: "paired", listed: true, paired: true });
  });

  it("falls back from a directory entry without a relay to the pairing's, and to null when neither knows one", () => {
    const pcs = dashboardPcs(
      [row("paired", "paired", { listed: true }), row("unknown", "needs-approval", { listed: true })],
      [{ server_id: "paired", relay: "wss://relay.example" }],
      [{ server_id: "paired", relay: null }, { server_id: "unknown", relay: null }],
    );
    expect(pcs.map(({ relay }) => relay)).toEqual(["wss://relay.example", null]);
    // the model then puts the unknown one under the shell's default relay
    expect(dashboardModel(pcs, { label: "Me" }, "wss://relay.ovis.sh").relays.map(({ origin, pcs: ids }) => [origin, ids])).toEqual([["wss://relay.example", ["paired"]], ["wss://relay.ovis.sh", ["unknown"]]]);
  });

  it("works without a directory: every saved pairing is a local PC on its own relay", () => {
    expect(dashboardPcs([row("a", "paired")], [{ server_id: "a", relay: "wss://relay-ap.ovis.sh" }]).map(({ relay }) => relay)).toEqual(["wss://relay-ap.ovis.sh"]);
  });
});
