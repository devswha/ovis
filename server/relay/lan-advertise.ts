/**
 * Telling phones on this PC's own network that it takes a join now (docs/relay.md, "Joining on the same Wi-Fi"): a
 * DNS-SD service `_ovis._tcp` over multicast DNS (RFC 6762, 6763), which Android's NsdManager and Apple's NWBrowser
 * find. Only while the LAN join window is open (lan-join.ts), and it names nothing but this PC's name and the direct
 * carrier's port (and the addresses that port is on, which a phone needs to reach it): no key, no id, no code.
 * A goodbye (TTL 0) takes it back when the window ends.
 */
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import type { Socket } from "node:dgram";

export const SERVICE_TYPE = "_ovis._tcp.local";
const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const TTL_SECONDS = 120;
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 } as const;
const CLASS_IN = 1;
const CACHE_FLUSH = 0x8000;

export interface LanService {
  /** this PC's name, as a phone lists it */
  readonly name: string;
  /** the direct carrier's port */
  readonly port: number;
  /** the private IPv4 addresses the direct carrier listens on */
  readonly addresses: readonly string[];
}

/** One DNS-SD label: at most 63 bytes of UTF-8, no dots (they would split it), never empty. */
export function instanceLabel(name: string): string {
  let label = name.replace(/\./g, "-").trim() || "Ovis";
  while (new TextEncoder().encode(label).byteLength > 63) label = label.slice(0, -1);
  return label;
}

function encodeName(name: string): Uint8Array {
  const parts: number[] = [];
  for (const label of name.split(".")) {
    const bytes = new TextEncoder().encode(label);
    parts.push(bytes.byteLength, ...bytes);
  }
  parts.push(0);
  return Uint8Array.from(parts);
}

function record(name: string, type: number, ttl: number, data: Uint8Array, flush: boolean): Uint8Array {
  const head = new Uint8Array(10);
  const view = new DataView(head.buffer);
  view.setUint16(0, type);
  view.setUint16(2, CLASS_IN | (flush ? CACHE_FLUSH : 0));
  view.setUint32(4, ttl);
  view.setUint16(8, data.byteLength);
  return concat([encodeName(name), head, data]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

/** The whole answer: PTR, SRV, an empty TXT and the A records, with `ttl` (0 says goodbye). */
export function announcement(service: LanService, host: string, ttl = TTL_SECONDS): Uint8Array {
  const instance = `${instanceLabel(service.name)}.${SERVICE_TYPE}`;
  const srv = new Uint8Array(6);
  new DataView(srv.buffer).setUint16(4, service.port);
  const answers = [
    record(SERVICE_TYPE, TYPE.PTR, ttl, encodeName(instance), false),
    record(instance, TYPE.SRV, ttl, concat([srv, encodeName(host)]), true),
    record(instance, TYPE.TXT, ttl, Uint8Array.of(0), true),
    ...service.addresses.map((address) => record(host, TYPE.A, ttl, Uint8Array.from(address.split(".").map(Number)), true)),
  ];
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  // a response, authoritative
  view.setUint16(2, 0x8400);
  view.setUint16(6, answers.length);
  return concat([header, ...answers]);
}

/** Reads a (possibly compressed) name at `offset`; null when the packet is malformed. */
function readName(packet: Uint8Array, offset: number): { name: string; next: number } | null {
  const labels: string[] = [];
  let at = offset;
  let next = -1;
  for (let jumps = 0; jumps < 16; ) {
    const length = packet[at];
    if (length === undefined) return null;
    if (length === 0) return { name: labels.join("."), next: next === -1 ? at + 1 : next };
    if ((length & 0xc0) === 0xc0) {
      const low = packet[at + 1];
      if (low === undefined) return null;
      if (next === -1) next = at + 2;
      at = ((length & 0x3f) << 8) | low;
      jumps += 1;
      continue;
    }
    if (at + 1 + length > packet.byteLength) return null;
    labels.push(new TextDecoder().decode(packet.subarray(at + 1, at + 1 + length)));
    at += 1 + length;
  }
  return null;
}

/** Whether a query asks for this service: PTR (or ANY) for `_ovis._tcp.local`, or anything about its instance or host. */
export function asksFor(packet: Uint8Array, service: LanService, host: string): boolean {
  if (packet.byteLength < 12) return false;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  // responses are not questions
  if ((view.getUint16(2) & 0x8000) !== 0) return false;
  const questions = view.getUint16(4);
  const instance = `${instanceLabel(service.name)}.${SERVICE_TYPE}`.toLowerCase();
  let at = 12;
  for (let index = 0; index < questions; index++) {
    const read = readName(packet, at);
    if (read === null || read.next + 4 > packet.byteLength) return false;
    const type = view.getUint16(read.next);
    const name = read.name.toLowerCase();
    if ((name === SERVICE_TYPE && (type === TYPE.PTR || type === TYPE.ANY)) || name === instance || name === host.toLowerCase()) return true;
    at = read.next + 4;
  }
  return false;
}

/**
 * Advertises `service` until the returned stop is called, which says goodbye. A network that will not take the
 * multicast socket (the port held without sharing, no interface) leaves this PC unlisted: the address the block shows
 * still works when typed.
 */
export function advertiseLan(service: LanService, make: () => Socket = () => createSocket({ type: "udp4", reuseAddr: true })): () => void {
  // a name of its own each time, so no stale cache of another window's addresses answers for it
  const host = `ovis-${randomBytes(4).toString("hex")}.local`;
  const socket = make();
  let open = false;
  let stopped = false;
  const send = (bytes: Uint8Array): void => {
    if (open) socket.send(bytes, MDNS_PORT, MDNS_ADDRESS, () => {});
  };
  socket.on("error", (error) => {
    console.warn(JSON.stringify({ event: "relay.lan_advertise.failed", error: error.message }));
    try { socket.close(); } catch {}
    open = false;
  });
  socket.on("message", (packet) => {
    if (asksFor(new Uint8Array(packet), service, host)) send(announcement(service, host));
  });
  socket.bind(MDNS_PORT, () => {
    if (stopped) { socket.close(); return; }
    try {
      for (const address of service.addresses) socket.addMembership(MDNS_ADDRESS, address);
      socket.setMulticastTTL(255);
      if (service.addresses[0] !== undefined) socket.setMulticastInterface(service.addresses[0]);
      open = true;
      send(announcement(service, host));
    } catch (error) {
      socket.emit("error", error instanceof Error ? error : new Error(String(error)));
    }
  });
  return () => {
    if (stopped) return;
    stopped = true;
    if (!open) return;
    send(announcement(service, host, 0));
    open = false;
    socket.close();
  };
}
