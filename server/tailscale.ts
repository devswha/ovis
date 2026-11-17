import { existsSync } from "node:fs";
import type { RemoteAccess, TailscaleAccess } from "../shared/protocol.ts";
import { addressesNode } from "./access.ts";

const TIMEOUT_MS = 2500;
/** the macOS App Store build puts no `tailscale` on the PATH; its CLI lives in the app bundle */
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
export const HTTPS_PORTS: readonly number[] = [443, 8443, 7317, 17317];
export const HTTPS_PORT_VARIABLE = "OVIS_TAILSCALE_HTTPS_PORT";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface TailscaleOutput {
  status: string | null;
  serve: string | null;
}

interface NodeJson { DNSName?: string; UserID?: number | string; TailscaleIPs?: string[]; Tags?: string[] }
interface StatusJson { BackendState?: string; Self?: NodeJson; Peer?: Record<string, NodeJson>; User?: Record<string, { LoginName?: string }> }
interface ServeJson {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean }>;
  /** "host:port" -> handlers by path */
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

const NONE: TailscaleAccess = { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null };

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

/**
 * `tailscale status --json` with every `UserID` kept as the digits written. Tailscale's user ids
 * pass 2^53, so as a double an id stops matching its key in `User`, and two ids can become one.
 */
function parseStatus(status: string | null): StatusJson | null {
  return parseJson<StatusJson>(status === null ? null : status.replace(/("UserID"\s*:\s*)(\d+)/g, '$1"$2"'));
}

function proxiesTo(target: string | undefined, port: number): boolean {
  if (!target) return false;
  try {
    const url = new URL(target);
    const targetPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return LOOPBACK.has(url.hostname) && targetPort === port && (url.pathname === "" || url.pathname === "/");
  } catch { return false; }
}

function httpsUrl(host: string, port: number): string {
  return `https://${host}${port === 443 ? "" : `:${port}`}`;
}

export function httpsPorts(value: string | undefined): readonly number[] {
  const text = value?.trim() ?? "";
  if (text === "") return HTTPS_PORTS;
  const port = /^\d+$/.test(text) ? Number(text) : 0;
  return port >= 1 && port <= 65535 ? [port] : [];
}

export function parseTailscale(output: TailscaleOutput | null, port: number, candidates: readonly number[] = HTTPS_PORTS): TailscaleAccess {
  if (output === null) return NONE;
  const status = parseJson<StatusJson>(output.status);
  if (status === null || status.BackendState !== "Running") return { ...NONE, state: "stopped" };
  const dns = parseNodeName(output.status);
  const serve = parseJson<ServeJson>(output.serve);
  const taken = new Set(Object.keys(serve?.TCP ?? {}).map(Number).filter(Number.isFinite));
  let servingUrl: string | null = null;
  for (const [hostPort, site] of Object.entries(serve?.Web ?? {})) {
    const separator = hostPort.lastIndexOf(":");
    const host = hostPort.slice(0, separator);
    const webPort = Number(hostPort.slice(separator + 1));
    // an HTTP listener is no use to a phone: it can neither install the app nor receive alerts
    if (!serve?.TCP?.[String(webPort)]?.HTTPS) continue;
    if (proxiesTo(site.Handlers?.["/"]?.Proxy, port)) { servingUrl = httpsUrl(host, webPort); break; }
  }
  const free = servingUrl === null ? candidates.find((candidate) => !taken.has(candidate)) ?? null : null;
  return {
    state: "running",
    dns_name: dns,
    serving_url: servingUrl,
    serve_command: free === null ? null : `tailscale serve --bg --https=${free} http://127.0.0.1:${port}`,
    serve_url: free === null || dns === null ? null : httpsUrl(dns, free),
  };
}

export function tailscaleBinary(): string | null {
  return Bun.which("tailscale") ?? (existsSync(MAC_APP_CLI) ? MAC_APP_CLI : null);
}

async function run(binary: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn([binary, ...args], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function readTailscale(binary: string | null = tailscaleBinary()): Promise<TailscaleOutput | null> {
  if (binary === null) return null;
  const [status, serve] = await Promise.all([run(binary, ["status", "--json"]), run(binary, ["serve", "status", "--json"])]);
  return { status, serve };
}

export async function remoteAccess(port: number, candidates: readonly number[] = httpsPorts(process.env[HTTPS_PORT_VARIABLE])): Promise<RemoteAccess> {
  return { port, tailscale: parseTailscale(await readTailscale(), port, candidates) };
}

/** A tagged node belongs to no person: its `User` entry is the node itself, named by its MagicDNS name. */
export function isTaggedNode(status: string | null): boolean {
  return (parseJson<StatusJson>(status)?.Self?.Tags?.length ?? 0) > 0;
}

export function parseTailscaleOwner(status: string | null): string | null {
  const parsed = parseStatus(status);
  const id = parsed?.Self?.UserID;
  if (id === undefined || id === null || isTaggedNode(status)) return null;
  return parsed?.User?.[String(id)]?.LoginName || null;
}

/**
 * A tagged node is the one case `tailscale serve` deliberately states no person for, and a tailnet
 * can hold many of those, which is why a proxied request with no login is otherwise a stranger.
 */
export function parseSoleTailnetLogin(status: string | null): string | null {
  return readSoleLogin(status).login;
}

function readSoleLogin(status: string | null): { login: string | null; settled: boolean } {
  // "every node" is every node this PC's Tailscale lists: a node an ACL hides is not in its network map
  const parsed = parseStatus(status);
  if (parsed === null || parsed.BackendState !== "Running") return { login: null, settled: false };
  const self = parsed.Self;
  if (self === undefined || self.UserID === undefined || self.UserID === null) return { login: null, settled: false };
  const owner = self.UserID;
  const nodes: NodeJson[] = [self, ...Object.values(parsed.Peer ?? {})];
  const sole = nodes.every((node) => (node.Tags?.length ?? 0) === 0
    && node.UserID !== undefined && node.UserID !== null && String(node.UserID) === String(owner));
  if (!sole) return { login: null, settled: true };
  const login = parsed.User?.[String(owner)]?.LoginName || null;
  return { login, settled: login !== null };
}

export function parseTailscaleIp(status: string | null): string | null {
  return parseJson<StatusJson>(status)?.Self?.TailscaleIPs?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
}

export function parseNodeName(status: string | null): string | null {
  return parseJson<StatusJson>(status)?.Self?.DNSName?.replace(/\.$/, "") || null;
}

export interface TailnetIdentity {
  owner: string | null;
  tagged: boolean;
  soleLogin: string | null;
  dnsName: string | null;
  tailnetIp: string | null;
}

const OWNER_TTL_MS = 5 * 60_000;
const LOGIN_RETRY_MS = 2_000;

const cliStatus = async (): Promise<string | null> => {
  const binary = tailscaleBinary();
  return binary === null ? null : run(binary, ["status", "--json"]);
};

export class TailnetIdentitySource {
  private cache: (TailnetIdentity & { at: number; settled: boolean; ownerKnown: boolean }) | null = null;
  private reading: Promise<void> | null = null;

  constructor(private readonly readStatus: () => Promise<string | null> = cliStatus) {}

  private async read(): Promise<void> {
    const status = await this.readStatus();
    if (status === null) {
      this.cache = {
        owner: this.cache?.owner ?? null,
        tagged: this.cache?.tagged ?? false,
        soleLogin: null,
        dnsName: this.cache?.dnsName ?? null,
        tailnetIp: this.cache?.tailnetIp ?? null,
        settled: false,
        ownerKnown: this.cache?.ownerKnown ?? false,
        at: Date.now(),
      };
      return;
    }
    const sole = readSoleLogin(status);
    const running = parseStatus(status)?.BackendState === "Running";
    const kept = !running && this.cache !== null && (this.cache.owner !== null || this.cache.tagged) ? this.cache : null;
    const owner = kept ? kept.owner : parseTailscaleOwner(status);
    const tagged = kept ? kept.tagged : isTaggedNode(status);
    this.cache = {
      owner,
      tagged,
      soleLogin: sole.login,
      dnsName: parseNodeName(status),
      tailnetIp: parseTailscaleIp(status),
      settled: sole.settled,
      ownerKnown: running && (owner !== null || tagged),
      at: Date.now(),
    };
  }

  private refresh(): Promise<void> {
    this.reading ??= this.read().finally(() => { this.reading = null; });
    return this.reading;
  }

  identity(): TailnetIdentity {
    if (this.cache === null || Date.now() - this.cache.at >= OWNER_TTL_MS) void this.refresh();
    return {
      owner: this.cache?.owner ?? null,
      tagged: this.cache?.tagged ?? false,
      soleLogin: this.cache?.soleLogin ?? null,
      dnsName: this.cache?.dnsName ?? null,
      tailnetIp: this.cache?.tailnetIp ?? null,
    };
  }

  async loginIdentity(): Promise<TailnetIdentity> {
    if (this.cache !== null && this.cache.ownerKnown) return this.identity();
    if (this.reading === null && this.cache !== null && Date.now() - this.cache.at < LOGIN_RETRY_MS) return this.identity();
    await this.refresh();
    return this.identity();
  }

  async freshIdentity(host: string | null): Promise<TailnetIdentity> {
    const cached = this.identity();
    if (this.cache !== null && this.cache.settled && (this.cache.soleLogin === null || !addressesNode({ host, dnsName: this.cache.dnsName, tailnetIp: this.cache.tailnetIp }))) return cached;
    await this.refresh();
    return this.identity();
  }
}
