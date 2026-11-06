/**
 * Settings → Connect a device → PCs on your Tailscale: other PCs of this PC's own Tailscale login whose Ovis
 * already lets this PC drive it, each added through the relay with one tap. Adding one asks that PC, over the
 * tailnet, for the code it would show under Connect a device, and spends it here as a typed code would
 * (MachineManager.addTailnet). Nothing new is trusted: the other PC answers only because `tailscale serve`
 * names this PC's login as its owner's (server/access.ts), the access that already drives it. The tailnet
 * itself admits nobody, and no account membership comes from it.
 */
import { HTTPS_PORTS, tailscaleBinary } from "./tailscale.ts";

const PROBE_MS = 2500;
/** an address the list found stays addable this long */
const FOUND_MS = 10 * 60_000;
/** peers asked at most, so a large tailnet costs a bounded number of requests */
const MAX_PEERS = 32;
/** systems that never run an Ovis server */
const PHONE_OS = new Set(["ios", "android"]);

export interface TailnetPcsOptions {
  /** `tailscale status --json`; null when Tailscale is not here */
  readStatus?: () => Promise<string | null>;
  /** the HTTPS ports `tailscale serve` may publish Ovis on */
  ports?: readonly number[];
  /** the address a peer's port is reached at; tests point it at a local server */
  origin?: (dnsName: string, port: number) => string;
}

export interface TailnetPc {
  name: string;
  url: string;
  /** that PC's relay phase: a code is asked only while it is online */
  relay: string | null;
}

interface PeerJson { DNSName?: string; UserID?: string; Online?: boolean; OS?: string; Tags?: string[] }
interface StatusJson { BackendState?: string; Self?: PeerJson; Peer?: Record<string, PeerJson> }

/** Online, untagged peers of this PC's own login, phones aside, from `tailscale status --json`. */
export function tailnetPeers(status: string | null): { name: string; dnsName: string }[] {
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
      return { name: dnsName.split(".")[0]!.slice(0, 100), dnsName };
    });
}

const readCli = async (): Promise<string | null> => {
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

interface Health { ok?: boolean; auth?: { authenticated?: boolean; via?: string; role?: string }; relay?: { phase?: string } | null }

export class TailnetPcs {
  private found = new Map<string, { name: string; at: number }>();
  private readonly readStatus: () => Promise<string | null>;
  private readonly ports: readonly number[];
  private readonly origin: (dnsName: string, port: number) => string;

  constructor(options: TailnetPcsOptions = {}) {
    this.readStatus = options.readStatus ?? readCli;
    this.ports = options.ports ?? HTTPS_PORTS;
    this.origin = options.origin ?? httpsOrigin;
  }

  /** this PC's login drives that Ovis as its owner: what `tailscale serve` says, never an open LAN window */
  private static drivable(health: Health): boolean {
    return health.ok === true && health.auth?.authenticated === true && health.auth.via === "tailscale" && health.auth.role === "drive";
  }

  private async probe(url: string): Promise<Health | null> {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(PROBE_MS), redirect: "error" });
      return response.ok ? await response.json() as Health : null;
    } catch { return null; }
  }

  /** The PCs found now, each at the first port its Ovis answers on. */
  async list(): Promise<TailnetPc[]> {
    const peers = tailnetPeers(await this.readStatus());
    const pcs = await Promise.all(peers.map(async ({ name, dnsName }): Promise<TailnetPc | null> => {
      const answers = await Promise.all(this.ports.map(async (port) => {
        const url = this.origin(dnsName, port);
        const health = await this.probe(url);
        return health !== null && TailnetPcs.drivable(health) ? { name, url, relay: health.relay?.phase ?? null } : null;
      }));
      return answers.find((answer) => answer !== null) ?? null;
    }));
    const now = Date.now();
    for (const [url, held] of this.found) if (now - held.at > FOUND_MS) this.found.delete(url);
    const listed = pcs.filter((pc): pc is TailnetPc => pc !== null);
    for (const pc of listed) this.found.set(pc.url, { name: pc.name, at: now });
    return listed;
  }

  /** the name a recent list found at this address, or null: no other address is ever asked for a code */
  foundAt(url: unknown): string | null {
    if (typeof url !== "string") return null;
    const held = this.found.get(url);
    return held !== undefined && Date.now() - held.at <= FOUND_MS ? held.name : null;
  }

  /**
   * The code that PC would show under Connect a device, asked of it as its owner (server/relay/routes.ts
   * /api/relay/code). Its trust is checked again first: the list may be minutes old.
   */
  async code(url: string): Promise<{ code: string; server_id: string }> {
    const health = await this.probe(url);
    if (health === null || !TailnetPcs.drivable(health)) throw new TailnetPcError("not_owner", "That PC no longer lets this PC in as its owner over Tailscale. Add it with its code instead.");
    if (health.relay?.phase !== "online") throw new TailnetPcError("relay_off", "Turn the relay on on that PC first, under Connect a device.");
    let response: Response;
    try {
      response = await fetch(`${url}/api/relay/code`, { method: "POST", headers: { "x-herdr-update": "1" }, signal: AbortSignal.timeout(15_000), redirect: "error" });
    } catch (error) {
      throw new TailnetPcError("unreachable", `That PC did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = await response.json().catch(() => null) as { code?: unknown; server_id?: unknown; error?: { message?: unknown } } | null;
    if (!response.ok || typeof body?.code !== "string" || typeof body.server_id !== "string") {
      const message = typeof body?.error?.message === "string" ? body.error.message : `HTTP ${response.status}`;
      throw new TailnetPcError("no_code", `That PC gave no code: ${message}`);
    }
    return { code: body.code, server_id: body.server_id };
  }
}

export class TailnetPcError extends Error {
  constructor(readonly failure: "not_found" | "not_owner" | "relay_off" | "unreachable" | "no_code" | "mismatch", message: string) { super(message); }
}
