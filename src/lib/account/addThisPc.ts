/**
 * Adding the PC this page is on to the account (docs/account.md, "Adding a PC"): signed in on its
 * own screen, the PC lists itself in the account's directory with its relay key, and opens a
 * pairing window whose comparisons only this PC approves. A device already in the account then
 * adds it with one approval: it types the number this PC shows, and the owner approves here.
 */
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { decodeOffer } from "../../../shared/relay-offer.ts";
import { requestRelayLink } from "../api.ts";
import { apiFetch } from "../api-request-id.ts";
import { pcAccountStatus } from "./join.ts";
import { NEW_PC_MS } from "./myPcs.ts";
import type { AccountService } from "./service.ts";

/** The account this PC belongs to; null while it is in none. */
export async function thisPcAccount(): Promise<string | null> {
  return (await pcAccountStatus(apiFetch)).account;
}

/** Whether this PC belongs to no account yet: only such a PC offers to be added. */
export async function thisPcInNoAccount(): Promise<boolean> {
  return await thisPcAccount() === null;
}

/**
 * Opens this PC's approve-here pairing window again and nothing else: no directory call, so nothing is listed
 * and no device of the account is rung. A window lost to a restart of Ovis is back with the next call.
 */
export async function reopenAddWindow(): Promise<void> {
  await requestRelayLink({ localOnly: true });
}

/** Where a waiting Add this PC screen is kept across a reload of its tab. */
const WAITING_KEY = "ovis-add-pc-waiting";

/** A waiting Add this PC screen: the name this PC is listed under, and when the screen stops waiting (ms since the epoch). */
export interface AddPcWaiting { readonly name: string; readonly until: number }

function tabStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage ?? null; } catch { return null; }
}

/** The waiting screen this tab kept, expired or not; null when it kept none or its storage cannot be read. */
export function readAddPcWaiting(): AddPcWaiting | null {
  try {
    const kept = JSON.parse(tabStorage()?.getItem(WAITING_KEY) ?? "null") as { name?: unknown; until?: unknown } | null;
    return kept !== null && typeof kept === "object" && typeof kept.name === "string" && typeof kept.until === "number" && Number.isFinite(kept.until) ? { name: kept.name.slice(0, 48), until: kept.until } : null;
  } catch { return null; }
}

/** Keeps the waiting screen for a reload of this tab, or forgets it (null). Without storage the screen works as before, not resumed. */
export function keepAddPcWaiting(waiting: AddPcWaiting | null): void {
  try {
    if (waiting === null) tabStorage()?.removeItem(WAITING_KEY);
    else tabStorage()?.setItem(WAITING_KEY, JSON.stringify(waiting));
  } catch { /* a full or blocked storage: the screen only loses its resume */ }
}

/**
 * Lists this PC in the account's directory and opens its approve-here pairing window; its name as
 * listed. An entry the card would stop showing before the next relist (`RELIST_MS`) is listed anew,
 * which shows the card again and rings the account's devices, so the card lasts as long as this screen waits.
 */
export async function listThisPc(service: AccountService, options: { relistMs: number }): Promise<string> {
  const offer = decodeOffer((await requestRelayLink({ localOnly: true })).url);
  if (offer === null) throw new Error("This PC's pairing link did not parse");
  const listed = (await service.listPcs()).find((pc) => pc.server_id === offer.server_id);
  if (listed !== undefined && Date.now() - Date.parse(listed.added_at) >= NEW_PC_MS - options.relistMs) await service.deletePc(offer.server_id);
  const name = (offer.name ?? offer.server_id.slice(0, 8)).slice(0, 48);
  const publicKey = Array.from(importPublicKey(offer.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
  await service.putPc(offer.server_id, { label: name, public_key: publicKey, relay: offer.relay });
  // the account this PC now asks its relay pass under (docs/relay.md, "Relay pass"); an older PC has no such route
  const session = await service.session();
  if (session) {
    // never in the way of pairing, so not awaited: a failing or hanging setup never holds the pairing wait, and the
    // relay status says when this PC has no pass (404: an Ovis from before relay passes)
    void apiFetch("/api/account/relay-account", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ account: session.account }) }).then(
      (named) => { if (!named.ok && named.status !== 404) console.warn("Ovis: this PC did not take the account for its relay pass", named.status); },
      (error: unknown) => console.warn("Ovis: this PC did not take the account for its relay pass", error instanceof Error ? error.name : error),
    );
  }
  return name;
}
