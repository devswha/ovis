export {
  openClientSecureChannel, openDaemonSecureChannel,
  generateKeyPair, exportPublicKey, importPublicKey, exportSecretKey, importSecretKey,
  SecureChannelRejectedError, PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE,
  PROTECTED_MODE_REQUIRED_CLOSE_CODE, PROTECTED_MODE_REQUIRED_CLOSE_REASON,
  PROTECTED_RECORD_FAILED_CLOSE_CODE,
} from "./vendor/paseo-e2ee/e2ee.ts";
export type {
  ClientSecureChannelOptions, DaemonSecureChannelOptions, SecureChannel,
  SecureChannelEvents, SecurityMode, Transport, TransportMessage, KeyPair, SharedKey,
} from "./vendor/paseo-e2ee/e2ee.ts";
