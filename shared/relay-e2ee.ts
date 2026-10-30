import {
  openClientSecureChannel as openClient, openDaemonSecureChannel as openDaemon,
} from "./vendor/paseo-e2ee/e2ee.ts";
import type {
  ClientSecureChannelOptions as ClientOptions, DaemonSecureChannelOptions as DaemonOptions, Transport,
} from "./vendor/paseo-e2ee/e2ee.ts";

export type ClientSecureChannelOptions = Omit<ClientOptions, "minimumMode">;
export type DaemonSecureChannelOptions = Omit<DaemonOptions, "minimumMode">;

export const openClientSecureChannel = (transport: Transport, options: ClientSecureChannelOptions) =>
  openClient(transport, { ...options, minimumMode: "protected" });
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
