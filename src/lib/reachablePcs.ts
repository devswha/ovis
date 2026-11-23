import type { Machine } from "../../shared/machines.ts";
import type { SshCandidate } from "./api.ts";

/**
 * One machine this PC can reach over SSH, as Add a connection's Tailscale and relay tabs list it: one row a machine, by
 * its machine name, as Tailscale's own machine list draws them. The ssh config hosts that the server resolved to a PC of
 * this PC's Tailscale login (`tailnet`) are one row with that PC's own entry. Any other config host is a row of its own:
 * two aliases of one HostName may still part by Port or ProxyJump, which this page is not told.
 */
export interface ReachablePc {
  readonly key: string;
  /** Tailscale's machine name for a PC of the login, else the config alias */
  readonly name: string;
  readonly way: "tailscale" | "ssh_config";
  /** the MagicDNS name, or user@hostname as the config resolves it */
  readonly address: string;
  /** what Add and Connect open: the first config alias that reaches it, so its User, key and port apply, else the MagicDNS name */
  readonly destination: string;
  readonly tailnet?: string;
  readonly found: readonly SshCandidate[];
}

const dnsName = (name: string): string => name.toLowerCase().replace(/\.$/, "");

export function reachablePcs(found: readonly SshCandidate[]): ReachablePc[] {
  const groups = new Map<string, SshCandidate[]>();
  for (const pc of found) {
    const key = pc.tailnet === undefined ? `ssh:${pc.destination}` : `tailnet:${dnsName(pc.tailnet)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [pc]);
    else group.push(pc);
  }
  return [...groups].map(([key, pcs]) => {
    const opens = pcs.find((pc) => pc.source === "ssh_config") ?? pcs[0]!;
    if (opens.tailnet === undefined) return { key, name: opens.name, way: "ssh_config", address: opens.detail ?? opens.destination, destination: opens.destination, found: pcs };
    const tailnet = dnsName(opens.tailnet);
    return { key, name: tailnet.split(".")[0]!, way: "tailscale", address: tailnet, destination: opens.destination, tailnet, found: pcs };
  });
}

/**
 * - `in-account`: its relay ID is one of the account's PCs.
 * - `added`: this app has it already, at one of its addresses as Add would add it, or (with the account's PCs given)
 *   by its relay ID through the relay.
 * - `outdated`: its Ovis is older than 0.5. `waiting`: a Tailscale PC whose Ovis is not known yet.
 */
export type ReachableState = "in-account" | "added" | "outdated" | "waiting" | "open";

export interface ReachableFacts {
  readonly machines: readonly Machine[];
  /** the Tailscale PCs' own answers (GET /api/machines/tailnet), by MagicDNS name; `read` once that list came or failed */
  readonly tailnet: { readonly read: boolean; readonly pcs: ReadonlyMap<string, { readonly outdated: boolean; readonly server_id: string | null }> };
  /** the relay IDs of the account's PCs: given only where the row adds a PC to the account */
  readonly accountPcs?: ReadonlySet<string>;
}

export function reachableState(row: ReachablePc, { machines, tailnet, accountPcs }: ReachableFacts): ReachableState {
  const at = machines.find(({ target }) => target !== undefined && (target.port ?? 22) === 22 && target.session === undefined && row.found.some((pc) => pc.destination === target.destination));
  const answer = row.tailnet === undefined ? undefined : tailnet.pcs.get(row.tailnet);
  const ids = [at?.server_id, answer?.server_id].filter((id): id is string => typeof id === "string");
  if (accountPcs !== undefined && ids.some((id) => accountPcs.has(id))) return "in-account";
  if (at !== undefined) return "added";
  if (accountPcs !== undefined && ids.some((id) => machines.some((machine) => machine.kind !== "local" && (machine.relay?.server_id ?? machine.server_id) === id))) return "added";
  if (answer?.outdated === true) return "outdated";
  if (row.tailnet !== undefined && !tailnet.read) return "waiting";
  return "open";
}
