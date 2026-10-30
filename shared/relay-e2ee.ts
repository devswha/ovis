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
  let closeError: Error | undefined;
  const outstanding = new Set<(error: Error) => void>();
  const rejectSends = () => {
    closeError ??= new Error("Secure channel closed");
    ready.resolve();
    for (const reject of outstanding) reject(closeError);
    outstanding.clear();
  };
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
        rejectSends();
        options.events?.onclose?.(code, reason);
      },
    },
  });
  channel.onClose(rejectSends);
  const send = channel.send.bind(channel);
  let chain = ready.promise;
  channel.send = (data) => {
    if (closeError) return Promise.reject(closeError);
    if (handshaking && ++pending > 200) return Promise.reject(new RangeError("Too many pre-open sends"));
    const result = Promise.withResolvers<void>();
    outstanding.add(result.reject);
    chain = chain.then(() => {
      if (closeError) throw closeError;
      return send(data);
    });
    // Caller settlement must not wait for an in-flight transport promise on close.
    // Remove settled callers rather than retaining one close listener per send.
    void chain.then(() => {
      outstanding.delete(result.reject);
      result.resolve();
    }, (error: unknown) => {
      outstanding.delete(result.reject);
      result.reject(error);
    });
    return result.promise;
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
