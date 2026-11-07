import "./RelayMap.css";

import { Lock, Monitor, MonitorSmartphone, RadioTower } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { relayHost, type dashboardModel } from "../lib/relay/dashboard.ts";
import { useT } from "../lib/i18n.ts";
import type { Translate } from "../lib/i18n.ts";

/*
 * The dashboard's connection map: this device on the left, one hub per relay (the first large, the
 * others small), the account's PCs on an orbit, wires between them. The technique follows GOAT's
 * FleetGraph (goat-si/goat @ cf6fbaee, apps/web/src/components/fleet/FleetGraph.tsx and
 * apps/web/src/index.css): a dashed orbit ellipse, cubic wires, a flowing stepped dash and SMIL
 * animateMotion particles on live wires. No code of it is used. The data is only what the front
 * page has (lib/relay/dashboard.ts): a PC's state and whether the account directory saw it lately.
 * A flowing wire means "seen lately", never an open session or a live connection; a paired PC the
 * directory never saw keeps a still wire and says so.
 */

export type RelayMapModel = ReturnType<typeof dashboardModel>["map"];
export type RelayMapNode = RelayMapModel["hubs"][number]["nodes"][number];

export type LabelSide = "right" | "above" | "below";
type Placed = { x: number; y: number; r: number; side: LabelSide };
export type PlacedPc = Placed & { kind: "pc"; node: RelayMapNode; hub: number };
export type PlacedHub = Placed & { kind: "hub"; hub: number; origin: string };
export type RelayMapLayout = {
  width: number;
  height: number;
  orbit: { cx: number; cy: number; rx: number; ry: number };
  me: Placed;
  primary: PlacedHub;
  items: (PlacedPc | PlacedHub)[];
};

const NODE_R = 22;
const HUB_R = 34;
const SMALL_HUB_R = 18;
/** degrees of the orbit the items share, the gap left of it being this device's */
const ARC = 300;
const MAX_STEP = 60;
/** within this many degrees of the orbit's right vertex the words sit beside the node; elsewhere they face away from the hub, clear of the wire */
const RIGHT_ZONE = 60;
/** from this many orbit items the orbit grows (a wider viewBox: smaller type, more room between words) */
const DENSE_FROM = 9;
const MAX_DOTS = 8;
/** a name longer than this (CJK counted double) is cut: the whole name stays in the node's title and in the route list */
const NAME_UNITS = 18;

type Slot = { kind: "pc"; node: RelayMapNode; hub: number } | { kind: "hub"; hub: number; origin: string };

/**
 * Where everything sits, by index alone, clockwise from the upper left: the first relay's PCs in
 * the middle of the arc (the right side), the other relays at the arc's ends nearest this device,
 * each after (or before) its own PCs so it is the end. One relay centres its fan on the right; a
 * second relay packs the sequence towards the lower left. `null` with no PC at all.
 */
export function layoutRelayMap(map: RelayMapModel): RelayMapLayout | null {
  const [first, ...others] = map.hubs;
  if (first === undefined) return null;
  const pcSlots = (hub: RelayMapModel["hubs"][number], at: number): Slot[] => hub.nodes.map((node) => ({ kind: "pc", node, hub: at }));
  const head: Slot[] = [];
  const tail: Slot[] = [];
  others.forEach((hub, i) => {
    const own: Slot = { kind: "hub", hub: i + 1, origin: hub.origin };
    if (i % 2 === 0) tail.push(...pcSlots(hub, i + 1), own);
    else head.unshift(own, ...pcSlots(hub, i + 1));
  });
  const slots = [...head, ...pcSlots(first, 0), ...tail];
  const n = slots.length;
  const dense = n >= DENSE_FROM;
  const rx = dense ? 430 : 300;
  const ry = dense ? 180 : 128;
  const cx = dense ? 640 : 480;
  const cy = ry + NODE_R + 36;
  const step = n > 1 ? Math.min(MAX_STEP, ARC / (n - 1)) : 0;
  const start = tail.length > 0 && head.length === 0 ? ARC / 2 - step * (n - 1) : -step * (n - 1) / 2;
  const items = slots.map((slot, i): PlacedPc | PlacedHub => {
    const degrees = start + step * i;
    const angle = degrees * Math.PI / 180;
    return {
      ...slot,
      r: slot.kind === "pc" ? NODE_R : SMALL_HUB_R,
      x: Math.round(cx + rx * Math.cos(angle)),
      y: Math.round(cy + ry * Math.sin(angle)),
      side: Math.abs(degrees) < RIGHT_ZONE ? "right" : degrees < 0 ? "above" : "below",
    };
  });
  return {
    width: cx * 2,
    height: cy + ry + NODE_R + 44,
    orbit: { cx, cy, rx, ry },
    me: { x: 110, y: cy, r: NODE_R, side: "below" },
    primary: { kind: "hub", hub: 0, origin: first.origin, x: cx, y: cy, r: HUB_R, side: "below" },
    items,
  };
}

/** The baseline of a node's first line and its anchor; the second line sits 14 under it. */
export function placeLabel({ x, y, r, side }: Placed, lines: 1 | 2): { x: number; y: number; anchor: "start" | "middle" } {
  if (side === "right") return { x: x + r + 12, y: lines === 2 ? y - 1 : y + 4, anchor: "start" };
  if (side === "above") return { x, y: y - r - (lines === 2 ? 22 : 8), anchor: "middle" };
  return { x, y: y + r + 16, anchor: "middle" };
}

/**
 * A wire from one ring to another. From the hub it leaves early, bends, and arrives level, as
 * GOAT's edges do; between two nodes on the orbit it keeps near its chord, bowed a little towards
 * `bow` (the orbit's centre), so it neither runs along the dashed orbit nor loops through the middle.
 */
function wire(from: Placed, to: Placed, bow: { x: number; y: number } | null = null): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const sx = from.x + dx / length * from.r;
  const sy = from.y + dy / length * from.r;
  const ex = to.x - dx / length * to.r;
  const ey = to.y - dy / length * to.r;
  const at = (v: number) => Math.round(v);
  if (bow === null) {
    return `M${at(sx)} ${at(sy)} C${at(sx + (ex - sx) * 0.32)} ${at(sy + (ey - sy) * 0.66)}, ${at(sx + (ex - sx) * 0.62)} ${at(sy + (ey - sy) * 0.94)}, ${at(ex)} ${at(ey)}`;
  }
  const pull = Math.min(36, Math.hypot(ex - sx, ey - sy) * 0.15);
  const control = (px: number, py: number): string => {
    const toBow = Math.hypot(bow.x - px, bow.y - py) || 1;
    return `${at(px + (bow.x - px) / toBow * pull)} ${at(py + (bow.y - py) / toBow * pull)}`;
  };
  return `M${at(sx)} ${at(sy)} C${control(sx + (ex - sx) / 3, sy + (ey - sy) / 3)}, ${control(sx + (ex - sx) * 2 / 3, sy + (ey - sy) * 2 / 3)}, ${at(ex)} ${at(ey)}`;
}

/** Text cut to `max` units, a CJK character counting two, with an ellipsis when cut. */
export function clip(text: string, max = NAME_UNITS): string {
  let units = 0;
  let end = 0;
  for (const ch of text) {
    units += /[\u2E80-\uFFFF]/.test(ch) ? 2 : 1;
    if (units > max) return `${text.slice(0, end)}…`;
    end += ch.length;
  }
  return text;
}

function keyOf(node: RelayMapNode): "lately" | RelayMapNode["state"] {
  return node.seen === "lately" ? "lately" : node.state;
}

/** The words under a PC: seen lately, paired but never seen, or what it waits for. */
function wordOf(node: RelayMapNode, t: Translate): string {
  if (node.seen === "lately") return t("Seen lately");
  switch (node.state) {
    case "paired": return t("Paired · status unknown");
    case "needs-approval": return t("Needs approval");
    case "needs-update": return t("Update Ovis on it");
    case "offline": return t("Offline");
  }
}

function wireOf(seen: RelayMapNode["seen"]): "live" | "still" | "off" {
  return seen === "lately" ? "live" : seen === "stale" ? "off" : "still";
}

const isHub = (item: PlacedPc | PlacedHub): item is PlacedHub => item.kind === "hub";
const isPc = (item: PlacedPc | PlacedHub): item is PlacedPc => item.kind === "pc";

/** The map of the account's PCs; nothing at all without a PC (the dashboard shows its empty state). */
export function RelayMap({ map }: { map: RelayMapModel }) {
  const layout = layoutRelayMap(map);
  if (layout === null) return null;
  return <RelayMapFigure map={map} layout={layout} />;
}

function RelayMapFigure({ map, layout }: { map: RelayMapModel; layout: RelayMapLayout }) {
  const t = useT();
  const svg = useRef<SVGSVGElement>(null);
  const [paused, setPaused] = useState(false);

  // nothing moves off screen: the SMIL particles pause with the svg, the flowing dash through data-paused
  useEffect(() => {
    const node = svg.current;
    if (node === null) return;
    const watch = new IntersectionObserver(([entry]) => setPaused(entry !== undefined && !entry.isIntersecting));
    watch.observe(node);
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    const node = svg.current;
    if (node === null) return;
    if (paused) node.pauseAnimations();
    else node.unpauseAnimations();
  }, [paused]);

  const nodes = map.hubs.flatMap((hub) => hub.nodes);
  const count = (test: (node: RelayMapNode) => boolean) => nodes.filter(test).length;
  const counts = {
    lately: count((node) => node.seen === "lately"),
    ready: count((node) => node.state === "paired"),
    approval: count((node) => node.state === "needs-approval"),
    update: count((node) => node.state === "needs-update"),
    offline: count((node) => node.state === "offline"),
  };
  const summary = t("Connection map: {me}. Relays: {relays}. PCs: {pcs}. Seen lately: {lately}. Ready: {ready}. Needs you: {needsYou}. Offline: {offline}.", {
    me: map.me.label,
    relays: map.hubs.map((hub) => relayHost(hub.origin)).join(", "),
    pcs: nodes.length,
    lately: counts.lately,
    ready: counts.ready,
    needsYou: counts.approval + counts.update,
    offline: counts.offline,
  });
  const legend: [key: string, label: string][] = [
    ...(counts.lately > 0 ? [["lately", t("Seen lately")] as [string, string]] : []),
    ...(counts.ready > 0 ? [["paired", t("Ready")] as [string, string]] : []),
    ...(counts.approval > 0 ? [["needs-approval", t("Needs approval")] as [string, string]] : []),
    ...(counts.update > 0 ? [["needs-update", t("Update Ovis on it")] as [string, string]] : []),
    ...(counts.offline > 0 ? [["offline", t("Offline")] as [string, string]] : []),
  ];

  const hubs = [layout.primary, ...layout.items.filter(isHub)].sort((a, b) => a.hub - b.hub);
  const pcs = layout.items.filter(isPc);
  const pcsOf = (hub: number) => pcs.filter((pc) => pc.hub === hub);
  const { width, height, orbit, me } = layout;
  const wireTo = (pc: PlacedPc) => wire(hubs[pc.hub]!, pc, pc.hub === 0 ? null : { x: orbit.cx, y: orbit.cy });
  const liveWires = pcs.filter((pc) => pc.node.seen === "lately").map(wireTo);

  return (
    <figure className="relay-map">
      {legend.length > 0 && (
        <ul className="relay-map-legend">
          {legend.map(([key, label]) => <li key={key}><span className="relay-map-key" data-state={key} aria-hidden="true" />{label}</li>)}
        </ul>
      )}
      <svg ref={svg} className="relay-map-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary} data-paused={paused ? "" : undefined}>
        <ellipse className="relay-map-orbit" cx={orbit.cx} cy={orbit.cy} rx={orbit.rx} ry={orbit.ry} />
        {hubs.map((hub) => {
          const own = pcsOf(hub.hub);
          const live = own.some((pc) => pc.node.seen === "lately");
          const off = own.every((pc) => pc.node.seen === "stale");
          return <path key={hub.origin} className="relay-map-edge" data-wire={live ? "live" : off ? "off" : "still"} data-hub={hub.origin} d={wire(me, hub)} />;
        })}
        {pcs.map((pc) => <path key={pc.node.server_id} className="relay-map-edge" data-wire={wireOf(pc.node.seen)} data-pc={pc.node.server_id} d={wireTo(pc)} />)}
        {liveWires.map((d, i) => <path key={i} className="relay-map-flow" d={d} />)}
        {liveWires.slice(0, MAX_DOTS).map((d, i) => (
          <circle key={i} className="relay-map-dot" r={3.5}>
            <animateMotion dur="2.6s" begin={`${-(i * 0.37)}s`} repeatCount="indefinite" path={d} calcMode="spline" keyTimes="0;1" keyPoints="1;0" keySplines="0.45 0 0.35 1" />
          </circle>
        ))}
        {hubs.map((hub) => {
          const label = placeLabel(hub, 1);
          return (
            <g key={hub.origin} className={hub.hub === 0 ? "relay-map-hub" : "relay-map-hub relay-map-hub-small"} transform={`translate(${hub.x} ${hub.y})`} data-hub={hub.origin}>
              <circle className="relay-map-hub-disc" r={hub.r} />
              {hub.hub === 0 ? <>
                <RadioTower className="relay-map-glyph" x={-12} y={-12} width={24} height={24} strokeWidth={1.8} />
                <rect className="relay-map-lock" x={16} y={16} width={20} height={20} rx={6} />
                <Lock className="relay-map-lock-glyph" x={20} y={20} width={12} height={12} strokeWidth={2.2} />
                <text className="relay-map-caption" y={56} textAnchor="middle">{`${relayHost(hub.origin)} · ${t("sees sizes, not content")}`}</text>
              </> : <>
                <RadioTower className="relay-map-glyph" x={-9} y={-9} width={18} height={18} strokeWidth={1.8} />
                <text className="relay-map-caption" x={label.x - hub.x} y={label.y - hub.y} textAnchor={label.anchor}>{clip(relayHost(hub.origin), 24)}</text>
              </>}
            </g>
          );
        })}
        <g className="relay-map-node" transform={`translate(${me.x} ${me.y})`} data-me="">
          <circle className="relay-map-ring" r={me.r} />
          <MonitorSmartphone className="relay-map-glyph" x={-10} y={-10} width={20} height={20} strokeWidth={1.8} />
          <text className="relay-map-name" y={placeLabel(me, 1).y - me.y} textAnchor="middle">{clip(map.me.label)}</text>
        </g>
        {pcs.map((pc) => {
          const label = placeLabel(pc, 2);
          return (
            <g key={pc.node.server_id} className="relay-map-node" transform={`translate(${pc.x} ${pc.y})`} data-pc-state={pc.node.state} data-seen={pc.node.seen}>
              <title>{pc.node.name}</title>
              <circle className="relay-map-ring" r={pc.r} />
              <Monitor className="relay-map-glyph" x={-10} y={-10} width={20} height={20} strokeWidth={1.8} />
              <text className="relay-map-name" x={label.x - pc.x} y={label.y - pc.y} textAnchor={label.anchor}>{clip(pc.node.name)}</text>
              <text className="relay-map-word" x={label.x - pc.x} y={label.y - pc.y + 14} textAnchor={label.anchor}>{wordOf(pc.node, t)}</text>
            </g>
          );
        })}
      </svg>
      <ol className="relay-map-routes" aria-label={summary}>
        {map.hubs.map((hub, at) => (
          <li key={hub.origin} className="relay-map-route">
            {at === 0 && <>
              <div className="relay-map-hop">
                <span className="relay-map-hop-mark"><MonitorSmartphone aria-hidden="true" /></span>
                <span className="relay-map-hop-name">{map.me.label}</span>
              </div>
              <div className="relay-map-link" data-live={counts.lately > 0 ? "" : undefined} aria-hidden="true" />
            </>}
            <div className="relay-map-hop relay-map-hop-hub">
              <span className="relay-map-hop-mark"><RadioTower aria-hidden="true" /></span>
              <span className="relay-map-host">{relayHost(hub.origin)}</span>
              {at === 0 && <small className="relay-map-hop-note"><Lock aria-hidden="true" />{t("sees sizes, not content")}</small>}
            </div>
            <ul className="relay-map-fan">
              {hub.nodes.map((node) => (
                <li key={node.server_id} className="relay-map-hop" data-pc-state={node.state} data-seen={node.seen}>
                  <span className="relay-map-key" data-state={keyOf(node)} aria-hidden="true" />
                  <span className="relay-map-hop-name">{node.name}</span>
                  <small className="relay-map-hop-note">{wordOf(node, t)}</small>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </figure>
  );
}
