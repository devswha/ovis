import {
  openClientSecureChannel as openClient, openDaemonSecureChannel as openDaemon,
} from "./vendor/paseo-e2ee/e2ee.ts";
import type {
  ClientSecureChannelOptions as ClientOptions, DaemonSecureChannelOptions as DaemonOptions, Transport,
} from "./vendor/paseo-e2ee/e2ee.ts";

export type ClientSecureChannelOptions = Omit<ClientOptions, "minimumMode">;
export type DaemonSecureChannelOptions = Omit<DaemonOptions, "minimumMode">;

export async function openClientSecureChannel(transport: Transport, options: ClientSecureChannelOptions) {
  // Never put application sends into the vendor's separate pre-open queue: it can
  // be overtaken by onopen sends. One chain waits for the handshake, then sends all.
  const ready = Promise.withResolvers<void>();
  let handshaking = true;
  let pending = 0;
  const channel = await openClient(transport, {
    ...options, minimumMode: "protected",
    events: {
      ...options.events,
      onopen: () => {
        handshaking = false;
        ready.resolve();
        options.events?.onopen?.();
      },
      onclose: (code, reason) => {
        handshaking = false;
        ready.resolve(); // Queued sends reject through the closed channel.
        options.events?.onclose?.(code, reason);
      },
    },
  });
  const send = channel.send.bind(channel);
  let chain = ready.promise;
  channel.send = (data) => {
    if (handshaking && ++pending > 200) return Promise.reject(new RangeError("Too many pre-open sends"));
    chain = chain.then(() => send(data));
    return chain;
  };
  return channel;
}
export const openDaemonSecureChannel = (transport: Transport, options: DaemonSecureChannelOptions) =>
  openDaemon(transport, { ...options, minimumMode: "protected" });

export {
  generateKeyPair, exportPublicKey, importPublicKey, exportSecretKey, importSecretKey,
  SecureChannelRejectedError, PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE,
  PROTECTED_MODE_REQUIRED_CLOSE_CODE, PROTECTED_MODE_REQUIRED_CLOSE_REASON,
  PROTECTED_RECORD_FAILED_CLOSE_CODE,
} from "./vendor/paseo-e2ee/e2ee.ts";
export type {
  SecureChannel,
  SecureChannelEvents, SecurityMode, Transport, TransportMessage, KeyPair, SharedKey,
} from "./vendor/paseo-e2ee/e2ee.ts";
