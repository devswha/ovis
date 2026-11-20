/**
 * Not me's signed blocks on their way to the account service (ledger S32-1, device table T51, T60): kept in this
 * device's account store before any PC or the service is sent one, and until the service has answered for each, so a
 * closed tab or a reload loses no block. A later attempt sends the same signed records again (the service takes a
 * record id once). Only the service's answer to the record itself removes it: no answer, a 5xx, 401, 408 or 429 keeps
 * it, and so does any failure before it went out (a refused token refresh, a sign-out).
 */
import type { BlockRecord } from "../../../shared/account-records.ts";
import { AccountRefreshError, AccountServiceError } from "./service.ts";
import type { AccountSession, AccountStore } from "./store.ts";

export interface UnsentBlocks {
  readonly account: string;
  /** the sign-in that signed them (absent on a sign-in from before ids were kept, which then matches only itself) */
  readonly sign_in_id: string | undefined;
  readonly records: readonly BlockRecord[];
}

/** How the service answered for a whole set: took it, found its target already removed, or refused it for good. */
export type Delivered = "sent" | "done" | "refused";

const RETRIED = new Set([401, 408, 429]);

/**
 * Stores `records` for `session`, one entry per record id, in one step with reading that it is still the stored
 * sign-in; false (nothing kept) when it is not. Call it before handing them to any PC or the service.
 */
export async function keepUnsent(store: AccountStore, session: AccountSession, records: readonly BlockRecord[]): Promise<boolean> {
  let kept = false;
  await store.updateMany(["session", "unsent_blocks"], (current) => {
    const stored = current.session;
    if (stored === undefined || stored.account !== session.account || stored.sign_in_id !== session.sign_in_id) return current;
    kept = true;
    const added = Object.fromEntries(records.map((record) => [record.id, { account: session.account, sign_in_id: session.sign_in_id, records: [record] }]));
    return { ...current, unsent_blocks: { ...current.unsent_blocks, ...added } };
  });
  return kept;
}

/**
 * Posts the kept `records` with `post`. Each record the service answered for leaves the store, by its id; one it may
 * still take stays as it is, and is never written back once something else removed it (its sign-out). The first such
 * failure is thrown once every record was tried.
 */
export async function postKept(store: AccountStore, session: AccountSession, records: readonly BlockRecord[], post: (record: BlockRecord) => Promise<void>): Promise<Delivered> {
  const answers = await Promise.allSettled(records.map(post));
  const answered = new Set(records.filter((_record, index) => {
    const answer = answers[index]!;
    return answer.status === "fulfilled" || final(answer.reason);
  }).map((record) => record.id));
  await store.update("unsent_blocks", (current) => {
    if (current === undefined) return undefined;
    const next = Object.fromEntries(Object.entries(current).filter(([id, entry]) =>
      !(answered.has(id) && entry.account === session.account)));
    return Object.keys(next).length === 0 ? undefined : next;
  });
  const retry = answers.find((answer): answer is PromiseRejectedResult => answer.status === "rejected" && !final(answer.reason));
  if (retry !== undefined) throw retry.reason;
  const refusals = answers.flatMap((answer) => answer.status === "rejected" ? [answer.reason as AccountServiceError] : []);
  if (refusals.some((refusal) => refusal.code !== "target_removed")) return "refused";
  return refusals.length > 0 ? "done" : "sent";
}

/** The service's refusal of the record itself that no retry can change: a 4xx other than 401, 408 and 429. */
function final(error: unknown): boolean {
  return error instanceof AccountServiceError && !(error instanceof AccountRefreshError) && error.status >= 400 && error.status < 500 && !RETRIED.has(error.status);
}

/**
 * The blocks signed under \`session\`'s account that the account service has not answered for, one record each: any
 * sign-in to that account sends them; another account never sees them.
 */
export async function unsentBlocks(store: AccountStore, session: AccountSession): Promise<UnsentBlocks[]> {
  const kept = await store.get("unsent_blocks");
  return Object.values(kept ?? {}).filter((entry) => entry.account === session.account);
}
