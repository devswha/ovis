/**
 * The contract between the web UI's pi extension (integrations/pi-ask.ts) and the server
 * (server/pi-ask-bridge.ts) for @eko24ive/pi-ask's ask_user form (#1202).
 *
 * pi-ask answers only through `pi.events` inside the pi process (its docs/remote-events.md: no
 * terminal keystrokes, no network API). The extension, which the user installs with
 * `bun scripts/install-pi-integration.ts`, listens there and serves HTTP on a unix socket that only
 * the user can open: `<pi agent dir>/<PI_ASK_BRIDGE_DIRECTORY>/<pid>.sock`.
 *
 *   GET  /v1/state   -> PiAskBridgeState: the forms pi-ask reports open, and the session file
 *   POST /v1/submit  PiAskSubmitRequest -> PiAskSubmitReply: pi-ask's own submit-result
 */

export const PI_ASK_BRIDGE_DIRECTORY = "herdr-web-ui-ask";
export const PI_ASK_BRIDGE_VERSION = 1;
/** How long the extension waits for pi-ask's submit-result before it answers `timeout`. */
export const PI_ASK_SUBMIT_TIMEOUT_MS = 3_000;
/** A unix socket path longer than this does not fit sockaddr_un on macOS (104 bytes, with its NUL). */
export const PI_ASK_SOCKET_PATH_MAX = 100;

/** pi-ask 1.2.0's channels (src/remote-ask.ts). */
export const PI_ASK_EVENTS = {
  started: "@eko24ive/pi-ask:started",
  completed: "@eko24ive/pi-ask:completed",
  submit: "@eko24ive/pi-ask:submit",
  submitResult: "@eko24ive/pi-ask:submit-result",
} as const;

export interface PiAskOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
  recommended?: boolean;
}

export interface PiAskQuestion {
  id: string;
  label?: string;
  prompt: string;
  type?: "single" | "multi" | "preview";
  required?: boolean;
  options: PiAskOption[];
}

/** One open form, as pi-ask's started event names it. */
export interface PiAskFlow {
  flowId: string;
  toolCallId?: string;
  source: string;
  title?: string;
  questions: PiAskQuestion[];
  createdAt: number;
}

export interface PiAskBridgeState {
  version: typeof PI_ASK_BRIDGE_VERSION;
  pid: number;
  /** The session file pi is writing, or null before it has one. */
  sessionFile: string | null;
  flows: PiAskFlow[];
}

export interface PiAskRemoteAnswer {
  values?: string[];
  customText?: string;
}

export type PiAskResponse =
  | { kind: "answer"; mode: "submit"; answers: Record<string, PiAskRemoteAnswer> }
  | { kind: "cancel" };

export interface PiAskSubmitRequest {
  flowId: string;
  /** The form the card was read from: pi-ask reopens a call's form under the same flowId. */
  createdAt: number;
  /** The session the card was read for. */
  sessionFile: string;
  response: PiAskResponse;
}

export type PiAskSubmitReply =
  | { ok: true }
  | { ok: false; error: "flow_not_found" | "invalid_request" | "invalid_answer" | "timeout"; message: string };
