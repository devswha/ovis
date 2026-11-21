/**
 * Joining from a phone on this PC's own network (docs/relay.md, "Joining on the same Wi-Fi"): while the owner has the
 * connect-a-phone block open in this PC's own window, a phone on the same network may ask to pair over a direct
 * carrier (server/relay/direct.ts) by comparing digits, as a codeless link pairs through the relay
 * (shared/relay-pair-sas.ts). Outside that window a comparison sent there is refused as before (`auth_failed`),
 * before any prompt.
 *
 * One window takes one comparison: a second phone is refused while one waits, and however the one taken ends
 * (approved, declined, expired, or the phone left), the window ends with it. The owner opens another by showing the
 * block again. Held in memory only: a restart ends it.
 */
import { randomBytes } from "node:crypto";
import { BlockList, isIP } from "node:net";

/** How long the block keeps the window open when it is never left, as a codeless link's window (pairing-approvals.ts). */
export const LAN_JOIN_WINDOW_MS = 10 * 60_000;

const lanJoinRanges = new BlockList();
for (const [network, prefix] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["169.254.0.0", 16]] as const) lanJoinRanges.addSubnet(network, prefix, "ipv4");
lanJoinRanges.addSubnet("fc00::", 7, "ipv6");
lanJoinRanges.addSubnet("fe80::", 10, "ipv6");
/** Tailscale's own addresses: its IPv4 range is outside the ones above, its IPv6 one is inside the ULA range */
const tailnetRanges = new BlockList();
tailnetRanges.addSubnet("100.64.0.0", 10, "ipv4");
tailnetRanges.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/**
 * A peer that may ask to join on the same network: RFC 1918, IPv4 link-local, an IPv6 unique local or link-local
 * address. Never loopback, a public address, a carrier-grade NAT or a tailnet one (Tailscale's ULA prefix included).
 */
export function lanJoinPeer(address: string | null | undefined): boolean {
  let plain = (address ?? "").replace(/%.*$/, "");
  if (plain.toLowerCase().startsWith("::ffff:") && isIP(plain.slice(7)) === 4) plain = plain.slice(7);
  const family = isIP(plain);
  if (family === 0) return false;
  const type = family === 4 ? "ipv4" : "ipv6";
  return lanJoinRanges.check(plain, type) && !tailnetRanges.check(plain, type);
}

interface Pending {
  readonly session: string;
  /** ends the comparison on its session, unapproved */
  readonly end: () => void;
}

export class LanJoinWindow {
  private until = 0;
  private id: string | null = null;
  private pending: Pending | null = null;
  private cancelExpiry: (() => void) | undefined;
  private readonly listeners = new Set<(open: boolean) => void>();
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => () => void;

  constructor(options: { now?: () => number; setTimer?: (run: () => void, ms: number) => () => void } = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((run, ms) => {
      const timer = setTimeout(run, ms);
      timer.unref();
      return () => clearTimeout(timer);
    });
  }

  /** The owner shows the block: a fresh window, whatever one was open (and whatever it was showing ends). */
  open(): string {
    this.end();
    const id = randomBytes(16).toString("hex");
    this.id = id;
    this.until = this.now() + LAN_JOIN_WINDOW_MS;
    this.cancelExpiry = this.setTimer(() => this.close(id), LAN_JOIN_WINDOW_MS);
    this.changed();
    return id;
  }

  /** The block was left, or its window ran out: a comparison it was showing ends unapproved. `id` closes that window only. */
  close(id?: string): void {
    if (id !== undefined && id !== this.id) return;
    const was = this.id !== null;
    this.end();
    if (was) this.changed();
  }

  private end(): void {
    this.until = 0;
    this.id = null;
    this.cancelExpiry?.();
    this.cancelExpiry = undefined;
    const pending = this.pending;
    this.pending = null;
    pending?.end();
  }

  isOpen(): boolean { return this.id !== null && this.now() < this.until; }

  /** Whether the window is open and nobody waits in it: what a new phone needs before it asks. */
  available(): boolean { return this.isOpen() && this.pending === null; }

  /** The one comparison this window takes; false while one waits or the window is closed. */
  claim(session: string, end: () => void): boolean {
    if (!this.available()) return false;
    this.pending = { session, end };
    return true;
  }

  /** Whether `session` still holds the window's one comparison. */
  holds(session: string): boolean { return this.isOpen() && this.pending?.session === session; }

  /** The comparison `session` held ended, however: the window ends with it, so nobody tries again in it. */
  finish(session: string): void {
    if (this.pending?.session !== session) return;
    this.pending = null;
    this.close();
  }

  /** Told true when a window opens, false when it ends: what advertises this PC on the network follows it. */
  subscribe(listener: (open: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    const open = this.isOpen();
    for (const listener of [...this.listeners]) listener(open);
  }
}
