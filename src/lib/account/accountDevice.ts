/**
 * Signing in to a PC as the account's device (device table T34, T40; Track D's account-joined rows): the row is
 * accountDeviceId(server_id, sign-in key) on that PC, signed with the sign-in key and pinned to the PC's own key.
 * The key never moves: an account-joined row is not relinked, so the store refuses any change to it.
 */
import { accountDeviceId } from "../../../shared/account-records.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import type { RelayDevice, RelayDeviceStore } from "../relay/device.ts";

export function accountDevice(offer: RelayOffer, key: { readonly private_key: CryptoKey; readonly public_spki: string }): RelayDevice {
  return {
    server_id: offer.server_id, server_public_key: offer.server_public_key, relay: offer.relay,
    ...(offer.name === undefined ? {} : { name: offer.name }),
    device_id: accountDeviceId(offer.server_id, key.public_spki), private_key: key.private_key, public_spki: key.public_spki, label: "Device",
  };
}

export class AccountRowImmutableError extends Error {
  constructor() {
    super("An account-joined row keeps its sign-in key");
    this.name = "AccountRowImmutableError";
  }
}

/** `store`, with `device` answered for its PC: every other PC's saved pairing stays as it is. */
export function withAccountDevice(store: RelayDeviceStore, device: RelayDevice): RelayDeviceStore {
  return {
    get: async (serverId) => serverId === device.server_id ? device : store.get(serverId),
    list: async () => [...(await store.list()).filter((saved) => saved.server_id !== device.server_id), device],
    remove: (serverId) => serverId === device.server_id ? Promise.resolve() : store.remove(serverId),
    update: (serverId, change, source) => serverId === device.server_id ? Promise.reject(new AccountRowImmutableError()) : store.update(serverId, change, source),
  };
}
