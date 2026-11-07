import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { dashboardModel } from "../lib/relay/dashboard.ts";
import type { DashboardPc } from "../lib/relay/dashboard.ts";
import { clip, layoutRelayMap, placeLabel, RelayMap } from "./RelayMap.tsx";
import type { RelayMapLayout, RelayMapModel } from "./RelayMap.tsx";

const GLOBAL = "wss://relay.ovis.sh";
const REGIONAL = "wss://relay-ap.ovis.sh";
const SELF = "wss://relay.example.test";

function pc(server_id: string, state: DashboardPc["state"], relay: string | null = null, last_seen_at: string | null = null): DashboardPc {
  return { server_id, name: server_id, state, relay, last_seen_at, added_at: null, listed: true, paired: state === "paired", linked: false };
}

const mockup = (): RelayMapModel => dashboardModel([
  pc("Desk PC", "paired", REGIONAL, "2026-11-07T00:00:00Z"),
  pc("MacBook", "paired", REGIONAL),
  pc("Mac mini", "needs-approval", REGIONAL, "2026-11-07T00:00:00Z"),
  pc("Home server", "offline", GLOBAL, "2026-11-01T00:00:00Z"),
], { label: "This iPhone" }, GLOBAL).map;

const render = (map: RelayMapModel, language: "en" | "ko" | "ja" | "zh" = "en"): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: [language] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayMap, { map }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

const wires = (html: string): Record<string, string> =>
  Object.fromEntries([...html.matchAll(/class="relay-map-edge" data-wire="(\w+)" data-pc="([^"]+)"/g)].map(([, wire, id]) => [id, wire]));
const count = (html: string, pattern: RegExp): number => (html.match(pattern) ?? []).length;

describe("the connection map", () => {
  it("draws one hub per relay and lets only the wires of PCs seen lately flow", () => {
    const html = render(mockup());
    expect(count(html, /class="relay-map-hub(?: relay-map-hub-small)?" transform/g)).toBe(2);
    expect(count(html, /class="relay-map-flow"/g)).toBe(1);
    expect(count(html, /class="relay-map-dot"/g)).toBe(1);
    expect(wires(html)).toEqual({ "Desk PC": "live", "MacBook": "still", "Mac mini": "still", "Home server": "off" });
    expect(html).toContain('data-pc-state="paired" data-seen="lately"');
    expect(html).toContain('<li><span class="relay-map-key" data-state="lately" aria-hidden="true"></span>Seen lately</li>');
  });

  it("keeps a still wire for a PC paired without an account, and says so under it", () => {
    const html = render(mockup());
    expect(wires(html)["MacBook"]).toBe("still");
    expect(html).toContain("Paired · status unknown");
    const paths = [...html.matchAll(/class="relay-map-(?:edge|flow)"[^>]* d="([^"]*)"/g)].map(([, d]) => d!);
    expect(paths).toHaveLength(7);
    expect(paths.filter((d) => !/^M-?\d+ -?\d+ C(-?\d+ -?\d+, ){2}-?\d+ -?\d+$/.test(d))).toEqual([]);
    expect(html).toContain("relay-ap.ovis.sh · sees sizes, not content");
    expect(html).toContain('class="relay-map-edge" data-wire="live" data-hub="wss://relay-ap.ovis.sh"');
    expect(html).toContain('class="relay-map-edge" data-wire="off" data-hub="wss://relay.ovis.sh"');
  });

  it("describes itself in counts, never as sessions or anything online", () => {
    const html = render(mockup());
    expect(html).toContain('aria-label="Connection map: This iPhone. Relays: relay-ap.ovis.sh, relay.ovis.sh. PCs: 4. Seen lately: 1. Ready: 2. Needs you: 1. Offline: 1."');
    expect(html).not.toMatch(/\b(session|online|connected)\b/i);
  });

  it("lists the same journey as rows for a phone: this device, each relay, the PCs behind it", () => {
    const html = render(mockup());
    const routes = html.slice(html.indexOf('<ol class="relay-map-routes"'));
    expect(count(routes, /class="relay-map-route"/g)).toBe(2);
    expect(count(routes, /class="relay-map-link" data-live=""/g)).toBe(1);
    expect(routes.indexOf("This iPhone")).toBeLessThan(routes.indexOf("relay-ap.ovis.sh"));
    expect(routes.indexOf("relay-ap.ovis.sh")).toBeLessThan(routes.indexOf("Desk PC"));
    expect(routes.indexOf("relay.ovis.sh</span>")).toBeLessThan(routes.indexOf("Home server"));
    expect(count(routes, /class="relay-map-hop" data-pc-state=/g)).toBe(4);
  });

  it("draws nothing without a PC", () => {
    expect(render(dashboardModel([], { label: "This iPhone" }, GLOBAL).map)).toBe("");
    expect(layoutRelayMap({ me: { label: "This iPhone" }, hubs: [] })).toBeNull();
  });

  it("wires every PC to its own relay, wherever that relay sits on the orbit", () => {
    const relays = [REGIONAL, GLOBAL, SELF];
    const map = dashboardModel(Array.from({ length: 12 }, (_, i) => pc(`pc-${i}`, "paired", relays[i % 3]!)), { label: "Me" }, GLOBAL).map;
    const layout = layoutRelayMap(map)!;
    const hubs = [layout.primary, ...layout.items.filter((item) => item.kind === "hub")];
    const html = render(map);
    const starts = Object.fromEntries([...html.matchAll(/class="relay-map-edge" data-wire="\w+" data-pc="([^"]+)" d="M(-?\d+) (-?\d+)/g)].map(([, id, x, y]) => [id, [Number(x), Number(y)]]));
    const strays = layout.items.flatMap((item) => {
      if (item.kind !== "pc") return [];
      const hub = hubs.find((candidate) => candidate.hub === item.hub)!;
      const [x, y] = starts[item.node.server_id]!;
      const gap = Math.abs(Math.hypot(x - hub.x, y - hub.y) - hub.r);
      return gap <= 1 ? [] : [`${item.node.server_id} leaves ${hub.origin} ${gap.toFixed(1)} off its ring`];
    });
    expect(Object.keys(starts)).toHaveLength(12);
    expect(strays).toEqual([]);
  });

  it("gives at most eight wires a moving dot", () => {
    const many = dashboardModel(Array.from({ length: 12 }, (_, i) => pc(`pc-${i}`, "paired", GLOBAL, "2026-11-07T00:00:00Z")), { label: "Me" }, GLOBAL).map;
    const html = render(many);
    expect(count(html, /class="relay-map-flow"/g)).toBe(12);
    expect(count(html, /class="relay-map-dot"/g)).toBe(8);
  });
});

type Box = { left: number; top: number; right: number; bottom: number; of: string };
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
/** Latin at --fs-xs semibold and --fs-2xs medium, a CJK character twice as wide; the widest word a node can carry under its name. */
const nameWidth = (text: string) => [...clip(text)].reduce((units, ch) => units + (/[\u2E80-\uFFFF]/.test(ch) ? 2 : 1), 0) * 7.4;
const WIDEST_WORD = "Paired · status unknown".length * 6.2;

function boxes(layout: RelayMapLayout, me: string): Box[] {
  const circle = (x: number, y: number, r: number, of: string): Box => ({ left: x - r, top: y - r, right: x + r, bottom: y + r, of });
  const words = (item: Parameters<typeof placeLabel>[0], lines: 1 | 2, width: number, of: string): Box => {
    const at = placeLabel(item, lines);
    const left = at.anchor === "middle" ? at.x - width / 2 : at.x;
    return { left, top: at.y - 10, right: left + width, bottom: at.y + (lines === 2 ? 17 : 3), of: `${of} words` };
  };
  const out: Box[] = [circle(layout.me.x, layout.me.y, layout.me.r, "me"), words(layout.me, 1, nameWidth(me), "me")];
  const { primary } = layout;
  out.push(circle(primary.x, primary.y, primary.r, "hub"));
  const caption = `${primary.origin.replace("wss://", "")} · sees sizes, not content`.length * 6.2;
  out.push({ left: primary.x - caption / 2, top: primary.y + 46, right: primary.x + caption / 2, bottom: primary.y + 59, of: "hub caption" });
  for (const item of layout.items) {
    if (item.kind === "pc") {
      out.push(circle(item.x, item.y, item.r, item.node.name), words(item, 2, Math.max(nameWidth(item.node.name), WIDEST_WORD), item.node.name));
    } else {
      out.push(circle(item.x, item.y, item.r, item.origin), words(item, 1, item.origin.replace("wss://", "").length * 6.2, item.origin));
    }
  }
  return out;
}

function expectNoOverlap(layout: RelayMapLayout, me: string) {
  const all = boxes(layout, me);
  const clashes = all.flatMap((a, i) => all.slice(i + 1).filter((b) => overlaps(a, b)).map((b) => `${a.of} / ${b.of}`));
  expect(clashes).toEqual([]);
  const outside = all.filter((box) => box.left < 0 || box.top < 0 || box.right > layout.width || box.bottom > layout.height).map((box) => box.of);
  expect(outside).toEqual([]);
}

describe("the orbit's layout", () => {
  it("keeps twelve PCs on three relays, with the longest names and words, apart", () => {
    const relays = [REGIONAL, GLOBAL, SELF];
    const pcs = Array.from({ length: 12 }, (_, i) => pc(`Workstation number ${i + 1}`, "paired", relays[i % 3]!));
    const map = dashboardModel(pcs, { label: "This iPhone" }, GLOBAL).map;
    const layout = layoutRelayMap(map)!;
    expect(map.hubs).toHaveLength(3);
    expect(layout.items).toHaveLength(14);
    expectNoOverlap(layout, "This iPhone");
    expect(new Set(layout.items.map((item) => `${item.x},${item.y}`)).size).toBe(14);
    // the other relays end the arc on this device's side, each beyond its own PCs; the first relay's PCs face right
    expect([layout.items[0]!.kind, layout.items[13]!.kind]).toEqual(["hub", "hub"]);
    expect(layout.items.slice(1, 5).map((item) => item.kind === "pc" && item.hub)).toEqual([2, 2, 2, 2]);
    expect(layout.items.slice(5, 9).map((item) => item.kind === "pc" && item.hub)).toEqual([0, 0, 0, 0]);
    expect(Math.max(...layout.items.map((item) => item.x))).toBe(Math.max(...layout.items.slice(5, 9).map((item) => item.x)));
  });

  it("keeps eight PCs on one relay apart, the fan centred on the right", () => {
    const pcs = Array.from({ length: 8 }, (_, i) => pc(`Workstation number ${i + 1}`, "offline", GLOBAL));
    const layout = layoutRelayMap(dashboardModel(pcs, { label: "This iPhone" }, GLOBAL).map)!;
    expectNoOverlap(layout, "This iPhone");
    expect(layout.width).toBe(960);
    expect(Math.min(...layout.items.map((item) => item.y))).toBeLessThan(layout.primary.y);
    expect(Math.max(...layout.items.map((item) => item.y))).toBeGreaterThan(layout.primary.y);
  });

  it("places the mockup's four PCs and second relay apart, that relay nearest this device", () => {
    const layout = layoutRelayMap(mockup())!;
    expectNoOverlap(layout, "This iPhone");
    const second = layout.items.find((item) => item.kind === "hub")!;
    expect(second.x).toBeLessThan(layout.primary.x);
    expect(layout.items.indexOf(second)).toBe(layout.items.length - 1);
  });

  it("cuts a long name once, CJK counted double, and keeps a short one whole", () => {
    expect(clip("Workstation number 12")).toBe("Workstation number…");
    expect(clip("Home server")).toBe("Home server");
    expect(clip("거실 책상 아래 서버 컴퓨터 하나")).toBe("거실 책상 아래 서…");
  });
});
