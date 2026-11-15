/**
 * The direct path for fleet machines (docs/fleet-link.md section 5, "Direct carriers"): while the fleet is in use, the
 * controller's direct listener (server/relay/direct.ts) also listens on its container and VM bridge adapters, so a
 * machine in a container or VM on the controller's own host reaches it without the relay, and a machine's AUTH_OK
 * names those carriers with the others. Phones keep the list of server/relay/direct.ts and its MAX_DIRECT_CARRIERS:
 * nothing here is told to a device.
 */
import type { NetworkInterfaceInfo } from "node:os";
import { isDirectCarrier } from "../../shared/relay-mux.ts";
import type { MachineState } from "./mux-ext.ts";

/** Container and VM bridges by adapter name (a subset of server/relay/direct.ts VIRTUAL_INTERFACE): never a VPN or tunnel. */
const BRIDGE_INTERFACE = /^(docker|br-|virbr|veth|podman|lxc|lxd|vmnet|vboxnet)/i;
/**
 * Bridge addresses listened on at most: Docker's default address pools alone make 31 local networks, and a listener
 * adds no bound of its own (the gate's connection counts are shared by every address).
 */
export const MAX_BRIDGE_ADDRESSES = 64;
/** Carriers a machine's AUTH_OK names at most: what fleet.json's `controller.direct` holds (docs/fleet-link.md, Fields). */
export const MAX_MACHINE_CARRIERS = 4;

const RFC1918: readonly [number, number, number][] = [[10, 0, 8], [172, 16, 12], [192, 168, 16]];

/** A private IPv4 address of RFC 1918 (not link-local, shared, documentation, public or unspecified). */
function rfc1918(address: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const value = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  return RFC1918.some(([a, b, prefix]) => (value >>> (32 - prefix)) === ((((a << 24) | (b << 16)) >>> 0) >>> (32 - prefix)));
}

/** This host's bridge adapter addresses: IPv4 of RFC 1918 on an adapter named as a bridge, in the system's order. */
export function bridgeAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const found = Object.entries(interfaces).flatMap(([name, list]) => BRIDGE_INTERFACE.test(name) ? list ?? [] : [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && rfc1918(entry.address))
    .map((entry) => entry.address);
  return [...new Set(found)].slice(0, MAX_BRIDGE_ADDRESSES);
}

/**
 * The fleet is in use while its store holds a machine that is not revoked (pending, active or quarantined: each may
 * sign in, or be let in again by the operator), or an invite that is unused and not expired (a machine may enrol on any
 * carrier its invite names, the bridge ones too). An empty store, one of revoked machines and spent invites only, or a
 * store that was refused (no machine can sign in) is not: the listener is then exactly what it is without a fleet.
 */
export function fleetInUse(directory: { machines(): readonly { readonly state: MachineState }[]; openInvites?(): number }): boolean {
  try { return directory.machines().some((machine) => machine.state !== "revoked") || (directory.openInvites?.() ?? 0) > 0; }
  catch { return false; }
}

/**
 * What a machine's AUTH_OK names: the home network's first carrier, the first bridge and the Tailscale one, then the
 * other home network and bridge carriers, each a direct carrier (private or Tailscale IPv4), at most
 * MAX_MACHINE_CARRIERS.
 */
export function machineCarriers(listened: { readonly lan: readonly string[]; readonly tailnet: readonly string[]; readonly bridges: readonly string[] }): string[] {
  const { lan, tailnet, bridges } = listened;
  const ordered = [lan[0], bridges[0], tailnet[0], ...lan.slice(1), ...bridges.slice(1)]
    .filter((carrier): carrier is string => carrier !== undefined && isDirectCarrier(carrier));
  return [...new Set(ordered)].slice(0, MAX_MACHINE_CARRIERS);
}
