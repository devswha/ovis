/**
 * A device that scanned a PC's QR code for its account names its account's signed list to that PC, in place of the
 * link (docs/account-list.md, "Adding a PC"): the pairing the scan made is an end-to-end session to the PC in front
 * of the person, so the PC's card is taken from that session and no number is compared. The device checks the card,
 * has the account admit the PC, signs the `pc` entry with that card, and asks the PC again until it read the entry.
 *
 * A PC that follows no list, or is from before lists, has no such call: the link goes as before.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { cardHolds, type ListNames } from "../../../shared/account-list.ts";
import { isListKeyEncoding } from "../../../shared/account-list-entry.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import type { AccountList } from "./accountList.ts";
import { AccountPcError, post, type PcFetch } from "./join.ts";
import { addPostedPc, type AddPcOutcome, type PostedPc } from "./listAdd.ts";

/**
 * What became of naming the list to the PC.
 *
 * - `none`: the PC has no such call (it follows no list, or is from before lists): send the link as before.
 * - `added`: the PC read the entry this device signed: it is in the list, and the pairing that named it is spent.
 * - `placed`: the entry is in the list, and the PC has not said yet that it read it: it will, at its next read.
 * - `refused`: nothing was signed, or the list did not take the entry; `why` is the PC's code, or the list's.
 */
export type NamedOutcome =
  | { readonly outcome: "none" | "added" | "placed" }
  | { readonly outcome: "refused"; readonly why: string; readonly add?: Extract<AddPcOutcome, { readonly added: false }> };

/** How often the PC is asked whether it read the entry: it counts the calls of one pairing. */
export const NAMED_ASKS = 4;
const NAMED_POLL_MS = 1_500;

/** The pause between two asks: inside a loop bounded by NAMED_ASKS. */
const pause = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason as Error); }, { once: true });
});

export async function nameListToPc(options: {
  readonly fetch: PcFetch; readonly list: AccountList; readonly account: string;
  /** The relay key of the PC this session is bound to, 64 hex: the card must be for it. */
  readonly endpoint: string;
  readonly names: ListNames | null;
  readonly admit: () => Promise<void>;
  readonly signal?: AbortSignal; readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<NamedOutcome> {
  const wait = options.wait ?? pause;
  const writer = options.list.writer();
  if (writer === null || writer.account !== options.account) return { outcome: "none" };
  const ask = async (): Promise<Record<string, unknown> | "none" | { readonly refused: string }> => {
    try {
      return await (await post(options.fetch, "/api/account/list/named", { account: options.account, list: writer.list })).json() as Record<string, unknown>;
    } catch (error) {
      if (!(error instanceof AccountPcError)) throw error;
      // no such call, or a PC that follows no list a person named
      return error.status === 404 ? "none" : { refused: error.code };
    }
  };
  const first = await ask();
  if (first === "none") return { outcome: "none" };
  if ("refused" in first && typeof first.refused === "string") return { outcome: "refused", why: first.refused };
  const said = first as Record<string, unknown>;
  if (said.state === "added") return { outcome: "added" };
  const { key, enc, card } = said;
  if (said.state !== "waiting" || typeof key !== "string" || !isListKeyEncoding(key) || typeof enc !== "string" || !isListKeyEncoding(enc) || typeof card !== "string") return { outcome: "refused", why: "invalid_answer" };
  const posted: PostedPc = { list: writer.list, endpoint: options.endpoint, server_id: deriveServerId(hexToBytes(options.endpoint)), key, enc, card };
  // the card is that key's own, for this device's list and the relay key this very session is bound to: nothing else is signed
  if (!await cardHolds({ key, enc, list: writer.list, endpoint: options.endpoint, invite: null }, card)) return { outcome: "refused", why: "card_invalid" };
  const added = await addPostedPc(options.list, posted, options.names, { admit: options.admit, expect: { account: options.account, list: writer.list } });
  if (!added.added) return { outcome: "refused", why: added.why === "admit" ? added.code ?? "admit" : added.why, add: added };
  for (let asks = 1; asks < NAMED_ASKS; asks += 1) {
    const again = await ask();
    if (again !== "none" && !("refused" in again && typeof again.refused === "string") && (again as Record<string, unknown>).state === "added") return { outcome: "added" };
    if (asks + 1 < NAMED_ASKS) await wait(NAMED_POLL_MS, options.signal);
  }
  return { outcome: "placed" };
}
