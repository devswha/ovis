/**
 * R13: the origins a world answers for. By default the world's own test names; with `--origin name=url` the exact
 * origins of a real run (M2's), so the app's built copy, the join line and the trial server's environment are the
 * same bytes in a rehearsal as in that run. Inside the sealed network the TLS proxy answers for exactly those host
 * names and ports with a certificate of the test CA. Pure: unit-tested in origins.test.ts.
 */
import { PlanError, PORTS } from "./constants.ts";

export type OriginName = "account" | "relay" | "app" | "kit";
export const ORIGIN_NAMES: readonly OriginName[] = ["account", "relay", "app", "kit"];
/** names whose origin serves a folder of files (`--site name=<dir>`) */
export const SITE_NAMES = ["app", "kit"] as const;
export type SiteName = typeof SITE_NAMES[number];

export interface Origin { readonly url: string; readonly host: string; readonly port: number }
export type Origins = Readonly<Partial<Record<OriginName, Origin>>> & { readonly account: Origin; readonly relay: Origin };

export const DEFAULT_ORIGINS: Origins = {
  account: { url: `https://account.world.test:${PORTS.tlsAccount}`, host: "account.world.test", port: PORTS.tlsAccount },
  relay: { url: `wss://relay.world.test:${PORTS.tlsRelay}`, host: "relay.world.test", port: PORTS.tlsRelay },
};

/** `relay=wss://host:port`, `account=https://host:port` (also app and kit): an origin, nothing after the port. */
export function parseOrigin(text: string): [OriginName, Origin] {
  const split = text.indexOf("=");
  const name = ORIGIN_NAMES.find((candidate) => candidate === text.slice(0, split));
  if (split < 0 || name === undefined) throw new PlanError(`--origin ${text}: <${ORIGIN_NAMES.join("|")}>=<url>`);
  let url: URL;
  try { url = new URL(text.slice(split + 1)); } catch { throw new PlanError(`--origin ${text}: not a URL`); }
  const scheme = name === "relay" ? "wss:" : "https:";
  if (url.protocol !== scheme) throw new PlanError(`--origin ${name} must be ${scheme}//…`);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") throw new PlanError(`--origin ${text}: an origin only (scheme, host, port)`);
  if (!/^[a-z0-9.-]+$/.test(url.hostname)) throw new PlanError(`--origin ${text}: a DNS name`);
  const port = url.port === "" ? 443 : Number(url.port);
  return [name, { url: `${scheme}//${url.hostname}${url.port === "" ? "" : `:${port}`}`, host: url.hostname, port }];
}

export function originsFrom(given: readonly string[]): Origins {
  const chosen: Partial<Record<OriginName, Origin>> = {};
  for (const [name, origin] of given.map(parseOrigin)) {
    if (chosen[name]) throw new PlanError(`--origin ${name} given twice`);
    chosen[name] = origin;
  }
  const merged = { ...DEFAULT_ORIGINS, ...chosen };
  const places = Object.values(merged).map((origin) => `${origin.host}:${origin.port}`);
  if (new Set(places).size !== places.length) throw new PlanError("two origins share a host and port");
  return merged;
}

export function sitesFrom(given: readonly string[], origins: Origins): Readonly<Partial<Record<SiteName, string>>> {
  const sites: Partial<Record<SiteName, string>> = {};
  for (const text of given) {
    const split = text.indexOf("=");
    const name = SITE_NAMES.find((candidate) => candidate === text.slice(0, split));
    if (split < 0 || name === undefined || text.length === split + 1) throw new PlanError(`--site ${text}: <app|kit>=<folder>`);
    sites[name] = text.slice(split + 1);
  }
  for (const name of SITE_NAMES) {
    if (sites[name] !== undefined && origins[name] === undefined) throw new PlanError(`--site ${name} needs --origin ${name}=https://…`);
    if (sites[name] === undefined && origins[name] !== undefined) throw new PlanError(`--origin ${name} needs --site ${name}=<folder> (what it serves)`);
  }
  return sites;
}

export interface ProxyTargets {
  readonly bind: string; readonly relay: string; readonly account: string; readonly site?: string;
  /**
   * The account service gets its own address as Host, not the origin's: the account service's `bun run local` (wrangler dev
   * --local) refuses every POST of its link page whose Host is the public one (403 "foreign", seen at afa04d4).
   * It builds its addresses from --public-url only, so nothing else reads the Host. The fake names its pages from it.
   */
  readonly accountHostIsItsOwn?: boolean;
}

/**
 * The TLS proxy's Caddyfile: each origin's host and port with the test certificate. The app is a single-page site;
 * the kit is plain files that a browser never runs (octet-stream, nosniff, no listing).
 */
export function caddyfile(targets: ProxyTargets, origins: Origins, extraHosts: readonly string[] = []): string {
  const block = (host: string, port: number, body: string) => `https://${host}:${port} {\n\ttls /certs/cert.pem /certs/key.pem\n${body}}\n`;
  const proxy = (to: string, port: number) => `\treverse_proxy ${to}:${port}\n`;
  const accountProxy = targets.accountHostIsItsOwn === true ? `\treverse_proxy ${targets.account}:${PORTS.account} {\n\t\theader_up Host {upstream_hostport}\n\t}\n` : proxy(targets.account, PORTS.account);
  const parts = [
    block(origins.relay.host, origins.relay.port, proxy(targets.relay, PORTS.relay)),
    block(origins.account.host, origins.account.port, accountProxy),
    ...extraHosts.map((host) => block(host, PORTS.tlsStaging, accountProxy)),
  ];
  if (origins.app) parts.push(block(origins.app.host, origins.app.port, targets.site !== undefined ? proxy(targets.site, 8080)
    : "\troot * /sites/app\n\theader X-Content-Type-Options nosniff\n\ttry_files {path} /index.html\n\tfile_server\n"));
  if (origins.kit) parts.push(block(origins.kit.host, origins.kit.port, "\troot * /sites/kit\n\theader X-Content-Type-Options nosniff\n\theader Content-Type application/octet-stream\n\theader Content-Disposition attachment\n\tfile_server\n"));
  return `{\n\tdefault_bind ${targets.bind}\n\tauto_https off\n\tadmin off\n}\n${parts.join("")}`;
}

/** Every DNS name the proxy answers for: the machines resolve them to the proxy inside the sealed network. */
export const proxyNames = (origins: Origins, extraHosts: readonly string[] = []) => [...new Set([...Object.values(origins).map((origin) => origin.host), ...extraHosts])];
