/**
 * Settings → Connect a device → PCs on your Tailscale: other PCs of this PC's own Tailscale login whose Ovis
 * already lets this PC drive it, each added through the relay with one tap. Adding one asks that PC, over the
 * tailnet, for the code it would show under Connect a device, and spends it here as a typed code would
 * (MachineManager.addTailnet). Nothing new is trusted: the other PC answers only because `tailscale serve`
 * names this PC's login as its owner's (server/access.ts), the access that already drives it. The tailnet
 * itself admits nobody, and no account membership comes from it.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { HTTPS_PORTS, tailscaleBinary } from "./tailscale.ts";
import { SERVER_ID_PATTERN } from "../shared/relay-id.ts";
import { TargetAccountPcError } from "../shared/relay-channel.ts";
import { isWssOrigin } from "../shared/relay-offer.ts";
import { GLOBAL_RELAY, REGIONAL_RELAYS } from "../shared/relay-regions.ts";

const PROBE_MS = 2500;
/** an address the list found stays addable this long */
const FOUND_MS = 10 * 60_000;
const MAX_PEERS = 32;
const PHONE_OS = new Set(["ios", "android"]);
/** a health or code answer is a few hundred bytes; anything past this is not one */
const MAX_BODY_BYTES = 64 * 1024;
const OVIS_RELAYS: readonly string[] = [GLOBAL_RELAY, ...Object.values(REGIONAL_RELAYS)];
/** a relay's host name that does not resolve in this long is not looked at */
const RESOLVE_MS = 5000;

/**
 * Addresses a relay another PC names may not lead to: a relay a phone meets that PC on is a public one, so this PC's
 * own loopback, the LAN, the tailnet, link-local (a cloud's metadata service lives there), unspecified, multicast,
 * special-use (192.0.0.0/24, the 198.18.0.0/15 benchmark range, site-local fec0::/10) and reserved addresses are
 * refused, and so is the IPv4-compatible ::/96 (::1 and :: in it). BlockList matches an IPv4-mapped IPv6 address
 * against the IPv4 rules itself. A host name is resolved here and again when the relay is dialled; only a PC of this
 * PC's own login that lets it drive names one, so a name that changes its answer in between is not guarded against.
 */
const INTERNAL = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) INTERNAL.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 96], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) INTERNAL.addSubnet(network, prefix, "ipv6");

const resolveHost = async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map((entry) => entry.address);

export interface TailnetPcsOptions {
  readStatus?: () => Promise<string | null>;
  ports?: readonly number[];
  origin?: (dnsName: string, port: number) => string;
  /** the addresses a relay's host name resolves to */
  resolveHost?: (host: string) => Promise<string[]>;
  /** how long a relay's host name may take to resolve */
  resolveMs?: number;
}

export interface TailnetPc {
  name: string;
  url: string;
  /** that PC's relay phase: a code is asked only while it is online */
  relay: string | null;
  /** that PC's Ovis predates typed codes (before 0.5): it is updated before one tap can add it */
  outdated: boolean;
  /** the relay ID that PC's own health names, so the page can tell a PC it already has or that is in its account; for display only, as that PC alone says it */
  server_id: string | null;
}

interface PeerJson { DNSName?: string; UserID?: string; Online?: boolean; OS?: string; Tags?: string[]; TailscaleIPs?: string[] }
interface StatusJson { BackendState?: string; Self?: PeerJson; Peer?: Record<string, PeerJson> }

/** Online, untagged peers of this PC's own login, phones aside, from `tailscale status --json`. */
export function tailnetPeers(status: string | null): { name: string; dnsName: string; ips: string[] }[] {
  if (status === null) return [];
  let parsed: StatusJson;
  // user ids pass 2^53: kept as the digits written, or two ids can become one
  try { parsed = JSON.parse(status.replace(/("UserID"\s*:\s*)(\d+)/g, '$1"$2"')) as StatusJson; } catch { return []; }
  const own = parsed.Self?.UserID;
  if (parsed.BackendState !== "Running" || own === undefined || (parsed.Self?.Tags?.length ?? 0) > 0) return [];
  return Object.values(parsed.Peer ?? {})
    .filter((peer) => peer.Online === true && (peer.Tags?.length ?? 0) === 0 && String(peer.UserID) === String(own)
      && typeof peer.DNSName === "string" && peer.DNSName !== "" && !PHONE_OS.has((peer.OS ?? "").toLowerCase()))
    .slice(0, MAX_PEERS)
    .map((peer) => {
      const dnsName = peer.DNSName!.replace(/\.$/, "");
      // the machine name Tailscale's admin console shows and lets the person rename, not the OS hostname
      return { name: dnsName.split(".")[0]!.slice(0, 100), dnsName, ips: (peer.TailscaleIPs ?? []).filter((ip) => typeof ip === "string") };
    });
}

/** `tailscale status --json` from this PC's own CLI, or null when Tailscale is not here or does not answer in time */
export const readTailscaleStatus = async (): Promise<string | null> => {
  const binary = tailscaleBinary();
  if (binary === null) return null;
  const proc = Bun.spawn([binary, "status", "--json"], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), PROBE_MS);
  try {
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? text : null;
  } catch { return null; } finally { clearTimeout(timer); }
};

const httpsOrigin = (dnsName: string, port: number) => `https://${dnsName}${port === 443 ? "" : `:${port}`}`;

/** The body as JSON, or null when it is not JSON or runs past MAX_BODY_BYTES; reading stops there. */
async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { void reader.cancel(); return null; }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return null; }
}

interface Health { web_ui?: { server_id?: string }; auth?: { authenticated?: boolean; via?: string; role?: string }; relay?: { phase?: string } | null }

export class TailnetPcs {
  private found = new Map<string, { name: string; dnsName: string; at: number }>();
  private listing: Promise<TailnetPc[]> | null = null;
  private readonly readStatus: () => Promise<string | null>;
  private readonly ports: readonly number[];
  private readonly origin: (dnsName: string, port: number) => string;
  private readonly resolveHost: (host: string) => Promise<string[]>;
  private readonly resolveMs: number;

  constructor(options: TailnetPcsOptions = {}) {
    this.readStatus = options.readStatus ?? readTailscaleStatus;
    this.ports = options.ports ?? HTTPS_PORTS;
    this.origin = options.origin ?? httpsOrigin;
    this.resolveHost = options.resolveHost ?? resolveHost;
    this.resolveMs = options.resolveMs ?? RESOLVE_MS;
  }

  /** one of Ovis's relays, or a wss origin whose host is and resolves only to public addresses */
  private async publicRelay(relay: string): Promise<boolean> {
    if (OVIS_RELAYS.includes(relay)) return true;
    const host = new URL(relay).hostname.replace(/^\[|\]$/g, "");
    let addresses: string[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("resolve timed out")), this.resolveMs); });
    try { addresses = isIP(host) !== 0 ? [host] : await Promise.race([this.resolveHost(host), late]); } catch { return false; } finally { clearTimeout(timer); }
    return addresses.length > 0 && addresses.every((address) => {
      const family = isIP(address);
      return family !== 0 && !INTERNAL.check(address, family === 4 ? "ipv4" : "ipv6");
    });
  }

  /** this PC's login drives that Ovis as its owner: what `tailscale serve` says, never an open LAN window; herdr there may be stopped */
  private static drivable(health: Health): boolean {
    return health.auth?.authenticated === true && health.auth.via === "tailscale" && health.auth.role === "drive";
  }

  /** the relay ID that PC names, only when it is shaped as one: its health is that PC's word, whatever it sends */
  private static relayId(health: Health): string | null {
    const id: unknown = health.web_ui?.server_id;
    return typeof id === "string" && SERVER_ID_PATTERN.test(id) ? id : null;
  }

  /**
   * An Ovis before typed codes: its health names no relay ID while its relay is online. Both came in the same
   * release (0.4.23), and an online relay always has its ID, so a current Ovis never looks like this.
   */
  private static outdated(health: Health): boolean {
    return health.relay?.phase === "online" && health.web_ui?.server_id === undefined;
  }

  private async probe(url: string): Promise<Health | null> {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(PROBE_MS), redirect: "error" });
      if (!response.ok) { void response.body?.cancel(); return null; }
      const health = await boundedJson(response);
      return typeof health === "object" && health !== null ? health as Health : null;
    } catch { return null; }
  }

  async list(): Promise<TailnetPc[]> {
    this.listing ??= this.discover().finally(() => { this.listing = null; });
    return await this.listing;
  }

  private async discover(): Promise<TailnetPc[]> {
    const peers = tailnetPeers(await this.readStatus());
    const pcs = await Promise.all(peers.map(async ({ name, dnsName }): Promise<(TailnetPc & { dnsName: string }) | null> => {
      const answers = await Promise.all(this.ports.map(async (port) => {
        const url = this.origin(dnsName, port);
        const health = await this.probe(url);
        return health !== null && TailnetPcs.drivable(health)
          ? { name, dnsName, url, relay: health.relay?.phase ?? null, outdated: TailnetPcs.outdated(health), server_id: TailnetPcs.relayId(health) } : null;
      }));
      const found = answers.filter((answer) => answer !== null);
      return found.find((answer) => answer.server_id !== null && answer.relay === "online") ?? found.find((answer) => answer.server_id !== null)
        ?? found.find((answer) => !answer.outdated) ?? found[0] ?? null;
    }));
    const listed = pcs.filter((pc) => pc !== null);
    // a fresh list replaces the last: a PC gone from it is no longer addable
    this.found = new Map(listed.map((pc) => [pc.url, { name: pc.name, dnsName: pc.dnsName, at: Date.now() }]));
    return listed.map(({ name, url, relay, outdated, server_id }) => ({ name, url, relay, outdated, server_id }));
  }

  /** the name a recent list found at this address, or null: no other address is ever asked for a code */
  foundAt(url: unknown): string | null {
    if (typeof url !== "string") return null;
    const held = this.found.get(url);
    return held !== undefined && Date.now() - held.at <= FOUND_MS ? held.name : null;
  }

  /**
   * The code that PC would show under Connect a device, asked of it as its owner (server/relay/routes.ts
   * /api/relay/code). Its trust is checked again first, Tailscale's word before the PC's: the list may be minutes old.
   */
  async code(url: string, added: ReadonlySet<string>): Promise<{ code: string; server_id: string; relay?: string }> {
    const held = this.found.get(url);
    const peers = tailnetPeers(await this.readStatus());
    if (held === undefined || !peers.some((peer) => peer.dnsName === held.dnsName)) throw new TailnetPcError("not_found", "That PC is no longer one of yours on Tailscale. Look again.");
    const health = await this.probe(url);
    if (health === null || !TailnetPcs.drivable(health)) throw new TailnetPcError("not_owner", "That PC no longer lets this PC in as its owner over Tailscale. Add it with its code instead.");
    if (health.web_ui?.server_id !== undefined && added.has(health.web_ui.server_id)) throw new TailnetPcError("already_added", "That PC is already added.");
    if (health.relay?.phase !== "online") throw new TailnetPcError("relay_off", "Turn the relay on on that PC first, under Add a connection.");
    if (TailnetPcs.outdated(health)) throw new TailnetPcError("outdated", OUTDATED);
    const id = TailnetPcs.relayId(health);
    let response: Response;
    try {
      response = await fetch(`${url}/api/relay/code`, { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-pc-add": "1" }, signal: AbortSignal.timeout(15_000), redirect: "error" });
    } catch {
      throw new TailnetPcError("unreachable", "That PC did not answer. Check that it is on, then try again.");
    }
    const body = await boundedJson(response) as { code?: unknown; server_id?: unknown; relay?: unknown; error?: { code?: unknown } } | null;
    if (!response.ok || typeof body?.code !== "string" || typeof body.server_id !== "string") {
      // that PC's own words never reach the person. Its health named its relay ID, so it is a current Ovis: a 404 or
      // 405 here comes from something in between, not from its version
      const refusal = body?.error?.code;
      if (refusal === "pc_add_target_bound") throw new TargetAccountPcError();
      if (refusal === "relay_off") throw new TailnetPcError("relay_off", "Turn the relay on on that PC first, under Add a connection.");
      if (refusal === "relay_offline") throw new TailnetPcError("relay_offline", "That PC's relay cannot be reached right now. Try again in a moment.");
      if (refusal === "code_unavailable") throw new TailnetPcError("code_unavailable", "That PC uses its own relay without an app of its own, so it cannot give a code. Add it with its QR code instead.");
      throw new TailnetPcError("no_code", "That PC could not give a code just now. Try again in a moment.");
    }
    // the code is that PC's own: the ID beside it is the one its health named to this PC, its owner over Tailscale
    if (body.server_id !== id) throw new TailnetPcError("mismatch", "That PC answered for a different PC than the one asked. Nothing was added.");
    // a PC on a relay of its own holds the code there; one that names none (an older Ovis) holds it on Ovis's. This
    // PC's server dials that relay, so one that leads inside a network is refused
    if (typeof body.relay !== "string" || !isWssOrigin(body.relay)) return { code: body.code, server_id: body.server_id };
    if (!await this.publicRelay(body.relay)) throw new TailnetPcError("code_unavailable", "That PC holds its codes on a relay that is not at a public address, so this PC does not look there. Add it with its QR code instead.");
    return { code: body.code, server_id: body.server_id, relay: body.relay };
  }
}

const OUTDATED = "That PC runs an older Ovis. Update it to 0.5 to add it here in one tap.";

export class TailnetPcError extends Error {
  constructor(readonly failure: "not_found" | "not_owner" | "already_added" | "relay_off" | "relay_offline" | "code_unavailable" | "outdated" | "unreachable" | "no_code" | "mismatch", message: string) { super(message); }
}
