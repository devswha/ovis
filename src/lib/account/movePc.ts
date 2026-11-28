import { bytesToHex } from "@noble/hashes/utils.js";
import type { AccountMoveAnswer, AccountMoveRequest, AccountMoveStatus } from "../../../shared/protocol.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { apiFetch } from "../api-request-id.ts";
import { ownPcProof } from "./pcProof.ts";
import { AccountServiceError, indexedAccountService, sameSignIn, SignedOutError } from "./service.ts";

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
export function moveThisPc(into: string, signal: AbortSignal, resuming: boolean): Promise<AccountMoveAnswer> {
  if (active?.into === into) return active.run;
  const stop = new AbortController();
  const run = execute(into, AbortSignal.any([signal, stop.signal]), resuming)
    .finally(() => { if (active?.stop === stop) active = null; });
  active = { into, stop, run };
  return run;
}

export async function resumePcMove(signal: AbortSignal): Promise<void> {
  const { into } = await pcMoveStatus(signal);
  if (into !== null && !signal.aborted) await moveThisPc(into, signal, true);
}

async function execute(into: string, signal: AbortSignal, resuming: boolean): Promise<AccountMoveAnswer> {
  const session = await indexedAccountService.session();
  signal.throwIfAborted();
  if (session?.account !== into) {
    if (resuming) return move({ into, stage: "cancel" });
    throw new SignedOutError();
  }
  const preparation = await move({ into, provider: session.provider, stage: "prepare" }, signal);
  if (preparation.state !== "prepare") return preparation;
  const { pc } = preparation;
  const directory = indexedAccountService.forSignIn(session);
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
    const current = await indexedAccountService.session();
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
