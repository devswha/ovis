/**
 * Settings → Devices and PCs → Add a connection → SSH: the PCs this PC's server could reach over SSH, for one
 * tap to open Add PC with the address filled in. Two sources, both read only, neither connected to:
 * the hosts named in its own account's ssh config, and the other PCs of its own Tailscale login (reached by
 * their MagicDNS name, over SSH like any other address, never through the relay).
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { readTailscaleStatus, tailnetPeers } from "./tailnet-pcs.ts";

/** an ssh config is a few kilobytes; past this it is not read on */
const MAX_FILE_BYTES = 256 * 1024;
/** Include may nest; ssh itself stops at 16 */
const MAX_INCLUDE_DEPTH = 4;
/** files one Include pattern reads at most */
const MAX_INCLUDED_FILES = 64;
/** hosts listed at most, so a generated config costs a bounded list */
const MAX_HOSTS = 200;

export interface SshCandidate {
  /** the Host alias, or the Tailscale machine name */
  name: string;
  /** what Add PC connects to: the alias itself (ssh resolves it through the config), or the MagicDNS name */
  destination: string;
  /** user@hostname as the config resolves it, or the MagicDNS name; null when the alias says nothing more */
  detail: string | null;
  source: "ssh_config" | "tailscale";
}

export interface SshCandidatesOptions {
  /** the folder holding `config`; `~/.ssh` of the server's own account by default */
  sshDir?: string;
  /** `tailscale status --json`; null when Tailscale is not here */
  readStatus?: () => Promise<string | null>;
}

/** a Host pattern that names one host, not a set of them */
const plainAlias = (pattern: string): boolean => pattern !== "" && !/[*?!]/.test(pattern);

/** `Key value`, `Key=value` and `Key "quoted value"`, as ssh reads a line; null for a blank line or a comment */
function keyword(line: string): { key: string; values: string[] } | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(trimmed);
  if (match === null) return null;
  const values = [...match[2]!.matchAll(/"([^"]*)"|(\S+)/g)].map((part) => part[1] ?? part[2]!);
  return { key: match[1]!.toLowerCase(), values };
}

interface HostBlock { aliases: string[]; hostname?: string; user?: string }

/**
 * The hosts an ssh config names, in its order, with the first HostName and User each block sets. Hosts named only
 * by a pattern (`*`, `?`, `!`) and everything under Match are left out; a later block repeating an alias adds nothing.
 * `include(pattern)` reads the files an Include names, as text, in their order.
 */
export async function sshConfigHosts(text: string, include: (pattern: string) => Promise<string[]> = async () => [], depth = 0): Promise<{ alias: string; hostname: string | null; user: string | null }[]> {
  const blocks: HostBlock[] = [];
  let current: HostBlock | null = null;
  let inMatch = false;
  for (const line of text.split(/\r?\n/)) {
    const parsed = keyword(line);
    if (parsed === null) continue;
    if (parsed.key === "host") {
      inMatch = false;
      current = { aliases: parsed.values.every(plainAlias) ? parsed.values : [] };
      blocks.push(current);
    } else if (parsed.key === "match") {
      inMatch = true;
      current = null;
    } else if (parsed.key === "include" && depth < MAX_INCLUDE_DEPTH && !inMatch) {
      // an Include inside a Host block applies to that block only; its own Host lines still start blocks of their own
      for (const pattern of parsed.values) {
        for (const included of await include(pattern)) {
          for (const host of await sshConfigHosts(included, include, depth + 1)) blocks.push({ aliases: [host.alias], ...(host.hostname === null ? {} : { hostname: host.hostname }), ...(host.user === null ? {} : { user: host.user }) });
        }
      }
    } else if (current !== null && !inMatch) {
      if (parsed.key === "hostname" && current.hostname === undefined) current.hostname = parsed.values[0];
      if (parsed.key === "user" && current.user === undefined) current.user = parsed.values[0];
    }
  }
  const seen = new Set<string>();
  const hosts: { alias: string; hostname: string | null; user: string | null }[] = [];
  for (const block of blocks) {
    for (const alias of block.aliases) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      hosts.push({ alias, hostname: block.hostname ?? null, user: block.user ?? null });
    }
  }
  return hosts.slice(0, MAX_HOSTS);
}

async function readCapped(path: string): Promise<string | null> {
  try {
    const bytes = await readFile(path);
    return bytes.subarray(0, MAX_FILE_BYTES).toString("utf8");
  } catch { return null; }
}

/** the files an Include pattern names: relative to `sshDir` as ssh reads the user config, `~` for the home folder */
function includer(sshDir: string): (pattern: string) => Promise<string[]> {
  return async (pattern) => {
    const expanded = pattern.startsWith("~/") ? join(homedir(), pattern.slice(2)) : isAbsolute(pattern) ? pattern : join(sshDir, pattern);
    const paths: string[] = [];
    if (/[*?[]/.test(expanded)) {
      for await (const path of new Bun.Glob(expanded).scan({ absolute: true, onlyFiles: true })) {
        paths.push(path);
        if (paths.length >= MAX_INCLUDED_FILES) break;
      }
      paths.sort();
    } else paths.push(expanded);
    const texts = await Promise.all(paths.map(readCapped));
    return texts.filter((text): text is string => text !== null);
  };
}

/**
 * The SSH tab's list: the ssh config's hosts, then the Tailscale PCs no config host already names (by alias,
 * HostName or MagicDNS name). Either source missing leaves the other.
 */
export async function sshCandidates(options: SshCandidatesOptions = {}): Promise<SshCandidate[]> {
  const sshDir = options.sshDir ?? join(homedir(), ".ssh");
  const [config, status] = await Promise.all([readCapped(join(sshDir, "config")), (options.readStatus ?? readTailscaleStatus)()]);
  const hosts = config === null ? [] : await sshConfigHosts(config, includer(sshDir));
  const fromConfig: SshCandidate[] = hosts.map(({ alias, hostname, user }) => ({
    name: alias,
    destination: alias,
    detail: hostname === null ? (user === null ? null : `${user}@${alias}`) : user === null ? hostname : `${user}@${hostname}`,
    source: "ssh_config",
  }));
  const named = new Set(hosts.flatMap(({ alias, hostname }) => [alias.toLowerCase(), ...(hostname === null ? [] : [hostname.toLowerCase().replace(/\.$/, "")])]));
  const fromTailnet: SshCandidate[] = tailnetPeers(status)
    .filter(({ name, dnsName }) => !named.has(name.toLowerCase()) && !named.has(dnsName.toLowerCase()))
    .map(({ name, dnsName }) => ({ name, destination: dnsName, detail: dnsName, source: "tailscale" }));
  return [...fromConfig, ...fromTailnet];
}
