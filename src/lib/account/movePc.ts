import { bytesToHex } from "@noble/hashes/utils.js";
import type { AccountMoveAnswer, AccountMoveRequest, AccountMoveStatus } from "../../../shared/protocol.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { apiFetch } from "../api-request-id.ts";
import { pcAccountStatus } from "./join.ts";
import { ownPcProof } from "./pcProof.ts";
import { type AccountService, AccountServiceError, indexedAccountService, sameSignIn, SignedOutError } from "./service.ts";

const path = "/api/account/move";
/** How often an open dialog reads a move this PC still finishes by itself. */
export const MOVE_STATUS_MS = 2_000;
const headers = { "content-type": "application/json", "x-herdr-machine": "1" };
let active: { readonly into: string; readonly stop: AbortController; readonly run: Promise<AccountMoveAnswer> } | null = null;

export async function pcMoveStatus(signal: AbortSignal): Promise<AccountMoveStatus> {
  const response = await apiFetch(path, { signal });
  // a PC with no move route (Step 2 off, an older Ovis) has no move; any other failed read says nothing of one
  if (response.status === 404) return { into: null };
  if (!response.ok) throw new Error(`PC move status returned ${response.status}`);
  return await response.json();
}

async function move(body: AccountMoveRequest, signal?: AbortSignal): Promise<AccountMoveAnswer> {
  const response = await apiFetch(path, { method: "POST", headers, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });
  if (!response.ok) throw new Error(`PC move returned ${response.status}`);
  return await response.json();
}

export function cancelPcMove(into: string): Promise<AccountMoveAnswer> {
  if (active?.into === into) active.stop.abort();
  return move({ into, stage: "cancel" });
}

/** The PC keeps the journal, and only the window that owns the destination sign-in exercises it. */
export function moveThisPc(into: string, signal: AbortSignal, resuming: boolean, service: AccountService = indexedAccountService): Promise<AccountMoveAnswer> {
  if (active?.into === into) return active.run;
  const stop = new AbortController();
  const run = execute(into, AbortSignal.any([signal, stop.signal]), resuming, service)
    .finally(() => { if (active?.stop === stop) active = null; });
  active = { into, stop, run };
  return run;
}

export async function resumePcMove(signal: AbortSignal): Promise<void> {
  const { into } = await pcMoveStatus(signal);
  if (into !== null && !signal.aborted) await moveThisPc(into, signal, true);
}

/** How often this PC's own window asks whether its account is gone, which the PC learns on its own reads of the service. */
export const GONE_CHECK_MS = 60_000;

/**
 * A PC whose account no longer exists (deleted, or folded into the account of its verified email) moves, with no question,
 * into the account its own window is signed in to. A PC in an account that still exists is never moved this way.
 */
export async function moveFromGoneAccount(signal: AbortSignal, service: AccountService = indexedAccountService): Promise<AccountMoveAnswer | null> {
  const status = await pcAccountStatus((input) => apiFetch(input, { signal }));
  if (status.accountGone !== true || status.account === null || signal.aborted) return null;
  const session = await service.session();
  if (session === undefined || session.account === status.account || signal.aborted) return null;
  // a move into that account given up (no relay slot there, say) is not tried again by itself: the window says why
  const { aborted } = await pcMoveStatus(signal);
  if (aborted?.account === session.account || signal.aborted) return null;
  return await moveThisPc(session.account, signal, false, service);
}

async function execute(into: string, signal: AbortSignal, resuming: boolean, service: AccountService): Promise<AccountMoveAnswer> {
  const session = await service.session();
  signal.throwIfAborted();
  if (session?.account !== into) {
    if (resuming) return move({ into, stage: "cancel" });
    throw new SignedOutError();
  }
  const preparation = await move({ into, provider: session.provider, stage: "prepare" }, signal);
  if (preparation.state !== "prepare") return preparation;
  const { pc } = preparation;
  const directory = service.forSignIn(session);
  try {
    if (!await directory.ownSignIn(signal)) throw new SignedOutError();
    const proof = await ownPcProof(pc.server_id, async (route) => {
      const response = await apiFetch(route, { method: "POST", headers, body: "{}", signal });
      if (!response.ok) throw new Error(`PC proof returned ${response.status}`);
      return await response.json();
    });
    signal.throwIfAborted();
    await directory.putPc(pc.server_id, {
      label: (pc.name ?? pc.server_id.slice(0, 8)).slice(0, 48),
      public_key: bytesToHex(importPublicKey(pc.public_key)), relay: pc.relay, ...proof,
    }, signal, undefined, { prove: true });
    await directory.admitPc(pc.server_id, signal);
    const current = await service.session();
    if (!current || !sameSignIn(current, session)) throw new SignedOutError();
  } catch (error) {
    signal.throwIfAborted();
    // A definitive refusal gives up before the switch, with no attempt to remove the target listing.
    if (error instanceof SignedOutError || (error instanceof AccountServiceError && error.status < 500 && error.status !== 408)) {
      return move({ into, stage: "cancel" });
    }
    throw error;
  }
  signal.throwIfAborted();
  return move({ into }, signal);
}
