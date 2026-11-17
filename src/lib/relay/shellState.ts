import type { Root } from "react-dom/client";
import type { PendingPushStore } from "../push.ts";
import type { AccountStore } from "../account/store.ts";
import type { EnrollmentState, RelayDeviceStore } from "./device.ts";
import type { openRelayTransport } from "./transport.ts";
import type { checkPc } from "./pcStatus.ts";
import type { offerFromCode } from "./pairCode.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { MuxProtocolError } from "../../../shared/relay-mux.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { decodeOffer } from "../../../shared/relay-offer.ts";
import type { UpdateStep } from "../../../shared/update.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import type { MyPc } from "../account/myPcs.ts";
import type { AccountProvider, AccountSession } from "../account/store.ts";
import { inNativeApp } from "../nativeApp.ts";
import { serverIdOfPath } from "../shellMode.ts";
import { RelayAdmissionTimeoutError, RelayNewSessionsRefusedError, RelayUnreachableError, UnsafeRelayDestinationError } from "./channel.ts";
import { ServerIdentityChangedError } from "./device.ts";
import type { TypedCodeFailure } from "./pairCode.ts";
import type { RelayDevice } from "./device.ts";
import { formatDashboardHash, isDashboardHash, parseDashboardHash } from "./dashboardRoute.ts";

export type KeySource = "link" | "saved";

export interface KeyMismatch { expected: string; received: string | null; from: KeySource }

export function keyIdOf(publicKey: string): string | null {
  try { return deriveServerId(importPublicKey(publicKey)); } catch { return null; }
}

export function keyMismatch(serverId: string, keys: readonly { key: string; from: KeySource }[]): KeyMismatch | null {
  for (const { key, from } of keys) {
    const received = keyIdOf(key);
    if (received !== serverId) return { expected: serverId, received, from };
  }
  return null;
}

export type RelayFailure = "pc-offline" | "pc-unresponsive" | "relay-unreachable" | "needs-update" | "revoked" | "identity-changed" | "code-expired" | "pair-declined" | "pair-unavailable" | "bad-offer"
  | "new-devices-refused"
  | "not-added-yet";

export type PcUpdate =
  | { phase: "reading" }
  | { phase: "offer" }
  | { phase: "manual" }
  | { phase: "installing"; step: UpdateStep | null }
  | { phase: "restarting" }
  | { phase: "failed"; detail: string | null };

export type AccountView =
  | { kind: "signed-out"; error: string | null; provider?: AccountProvider; notice?: string }
  | { kind: "signing-in"; provider?: AccountProvider }
  | { kind: "signed-in"; provider: AccountProvider; pcs: MyPc[] | null; error: string | null; deleteError?: string };

export interface EnrollmentCompletion { readonly state: "complete"; readonly admitted?: number }

export type RelayShellState =
  | { kind: "list"; devices: RelayDevice[]; account?: AccountView | null }
  | { kind: "outdated"; name: string | null; serverVersion: string; minVersion: string; update: PcUpdate }
  | { kind: "empty"; account?: AccountView | null }
  | { kind: "confirm"; offer: RelayOffer; account?: "checking" | "unlisted" | "listed"; pressed?: "unlisted" | "listed" | "own" }
  | { kind: "connecting"; name: string | null }
  | { kind: "ready"; name: string | null; server_id: string; enrollment?: EnrollmentState | "local" | EnrollmentCompletion }
  | { kind: "code-entry"; failure: TypedCodeFailure | null }
  | { kind: "code-looking" }
  | { kind: "code-compare"; offer: RelayOffer }
  | { kind: "compare"; name: string | null; digits: string; confirmed: boolean; typed?: boolean; wrong?: boolean; challenge?: number }
  | { kind: "forgotten"; name: string | null }
  | { kind: "forged"; name: string | null; mismatch: KeyMismatch | null }
  | { kind: "failed"; failure: RelayFailure; name: string | null; detail: string | null; mismatch?: KeyMismatch | null; server_id?: string };

export interface ShellEntry {
  serverId: string | null;
  offer: RelayOffer | null;
  damaged: boolean;
}

export function shellEntry(url: string): ShellEntry {
  const serverId = serverIdOfPath(new URL(url).pathname);
  try {
    const offer = decodeOffer(url);
    return { serverId, offer, damaged: false };
  } catch {
    return { serverId, offer: null, damaged: true };
  }
}

export function forgedOffer(offer: RelayOffer): boolean {
  return keyIdOf(offer.server_public_key) !== offer.server_id;
}

export function offerOf(device: RelayDevice): RelayOffer {
  return { v: 1, server_id: device.server_id, server_public_key: device.server_public_key, relay: device.relay, ...(device.name === undefined ? {} : { name: device.name }) };
}

export function failureOf(error: unknown, attempt: { code: boolean; paired: boolean; compared?: boolean; codeless?: boolean }): RelayFailure {
  if (error instanceof UnsafeRelayDestinationError) return "bad-offer";
  if (error instanceof RelayNewSessionsRefusedError) return "new-devices-refused";
  if (attempt.codeless && !attempt.code && !attempt.paired && !attempt.compared
    && error instanceof MuxProtocolError && error.code === "auth_failed") return "pair-unavailable";
  if (attempt.compared && (error instanceof RelayAdmissionTimeoutError
    || error instanceof MuxProtocolError && (error.code === "auth_failed" || error.code === "timeout"))) return "pair-declined";
  if (error instanceof ServerIdentityChangedError) return "identity-changed";
  if (error instanceof RelayUnreachableError) return "relay-unreachable";
  if (error instanceof RelayAdmissionTimeoutError) return "pc-unresponsive";
  if (!(error instanceof MuxProtocolError)) return "relay-unreachable";
  switch (error.code) {
    case "timeout": case "internal_error": case "auth_changed": return "pc-offline";
    case "auth_revoked": return "revoked";
    case "auth_failed": return attempt.code || !attempt.paired ? "code-expired" : "revoked";
    case "unsupported_version": case "unsupported_extension": case "unsupported_transport": return "needs-update";
    default: return "relay-unreachable";
  }
}

export function pairsAgainWithoutKey(error: unknown, attempt: { code: boolean; paired: boolean; compared?: boolean; refreshed?: boolean; codeless: boolean }): boolean {
  return attempt.codeless && !attempt.code && !attempt.compared && !attempt.refreshed
    && error instanceof MuxProtocolError && error.code === "auth_failed";
}

export function forgetsDevice(failure: RelayFailure): boolean {
  return failure === "revoked";
}

export function iosBrowserTab(env: { userAgent: string; maxTouchPoints: number; standalone: boolean | undefined }): boolean {
  const ios = /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
  return ios && env.standalone !== true && !inNativeApp();
}

export interface RelayShellMount {
  container: HTMLElement;
  entryUrl: string;
  renderApp: () => Root;
  createRoot?: (container: HTMLElement) => Root;
  store?: RelayDeviceStore;
  pendingPush?: PendingPushStore;
  open?: typeof openRelayTransport;
  navigate?: (path: string) => void;
  label?: string;
  shellVersion?: string;
  reload?: () => Promise<void>;
  findByCode?: typeof offerFromCode;
  accountStore?: AccountStore;
  accountService?: string | null;
  accountProviders?: readonly AccountProvider[];
  accountFetch?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
  openSignIn?: (url: string) => void;
  checkPc?: typeof checkPc;
}


export interface Attempt {
  offer: RelayOffer;
  typed?: boolean;
  code: boolean;
  paired: boolean;
  compared?: boolean;
  codeless?: boolean;
  refreshed?: boolean;
  fresh?: boolean;
  introducible?: boolean;
  accountEnrollment?: boolean;
  accountless?: boolean;
  signIn?: AccountSession;
  retryEnrollment?: boolean;
  retriedPending?: boolean;
}


export interface SheetJoin {
  readonly mode: "new" | "join";
  readonly server_id: string;
  readonly returnHash?: string;
}
export function dashboardHash(hash: string): string {
  return isDashboardHash(hash) ? formatDashboardHash(parseDashboardHash(hash)) : "";
}
export function sheetContext(serverId?: string): SheetJoin | null {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem("ovis-add-pc-sheet") ?? "null");
    sessionStorage.removeItem("ovis-add-pc-sheet");
    if (typeof kept !== "object" || kept === null || !("mode" in kept) || !("server_id" in kept)) return null;
    if ((kept.mode !== "new" && kept.mode !== "join") || kept.server_id !== serverId || typeof kept.server_id !== "string") return null;
    const returnHash = "returnHash" in kept && typeof kept.returnHash === "string" ? dashboardHash(kept.returnHash) : "";
    return { mode: kept.mode, server_id: kept.server_id, ...(returnHash ? { returnHash } : {}) };
  } catch { return null; }
}
export function keepSheetContext(join: SheetJoin): void {
  try { sessionStorage.setItem("ovis-add-pc-sheet", JSON.stringify({ mode: join.mode, server_id: join.server_id, returnHash: dashboardHash(join.returnHash ?? "") })); }
  catch {}
}
export function typedJoin(serverId: string): boolean {
  try { return sessionStorage.getItem("ovis-typed-join") === serverId; } catch { return false; }
}
export function keepTypedJoin(serverId: string | null): void {
  try { if (serverId === null) sessionStorage.removeItem("ovis-typed-join"); else sessionStorage.setItem("ovis-typed-join", serverId); }
  catch {}
}

export function keepConfirmedPc(serverId: string): void {
  try { sessionStorage.setItem("ovis-confirmed-pc", serverId); } catch {}
}
export function takeConfirmedPc(): string | null {
  try {
    const serverId = sessionStorage.getItem("ovis-confirmed-pc");
    sessionStorage.removeItem("ovis-confirmed-pc");
    return serverId;
  } catch { return null; }
}

export function keepDeviceOnlyPc(serverId: string | null): void {
  try { if (serverId === null) sessionStorage.removeItem("ovis-device-only-pc"); else sessionStorage.setItem("ovis-device-only-pc", serverId); }
  catch {}
}
export function deviceOnlyPc(): string | null {
  try { return sessionStorage.getItem("ovis-device-only-pc"); } catch { return null; }
}

export interface ConfirmedSignIn { readonly server_id: string; readonly sign_in_id: string | null }
export function keepConfirmedSignIn(confirmed: ConfirmedSignIn | null): void {
  try {
    if (confirmed === null) sessionStorage.removeItem("ovis-confirmed-sign-in");
    else sessionStorage.setItem("ovis-confirmed-sign-in", JSON.stringify({ server_id: confirmed.server_id, sign_in_id: confirmed.sign_in_id }));
  } catch {}
}
export function confirmedSignIn(): ConfirmedSignIn | null {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem("ovis-confirmed-sign-in") ?? "null");
    if (kept === null || typeof kept !== "object") return null;
    const { server_id, sign_in_id } = kept as Record<string, unknown>;
    if (typeof server_id !== "string") return null;
    return { server_id, sign_in_id: typeof sign_in_id === "string" && sign_in_id !== "" ? sign_in_id : null };
  } catch { return null; }
}
