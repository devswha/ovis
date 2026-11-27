import { hexToBytes } from "@noble/hashes/utils.js";
import { newRecordId, signAccountRecord } from "../../../shared/account-records.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import type { ShellDeviceStore } from "../relay/device.ts";
import { post, type PcFetch } from "./join.ts";
import { foldSeenPcs, readSeenPcs } from "./seenPcs.ts";
import { AccountService, sameSignIn } from "./service.ts";
import type { AccountKey, AccountSession, AccountStore } from "./store.ts";
import type { MergeKeys } from "./mergeKeys.ts";

type Cleanup = {
  readonly store: AccountStore;
  readonly service: AccountService;
  readonly devices: ShellDeviceStore;
  readonly session: AccountSession;
};
type PcSession = { readonly endpoint: string; readonly id: string; readonly key: string; readonly fetch: PcFetch };

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keysOf = (entry: MergeKeys): readonly AccountKey[] => [entry.key, entry.signIn?.key].filter((key) => key !== undefined);
const still = async ({ store, session }: Cleanup): Promise<boolean> => {
  const current = await store.get("session");
  return current !== undefined && sameSignIn(current, session);
};

/** A complete driving session's read is needed even for absence: watch sessions do not see account keys. */
async function oldRows(pc: PcSession, account: string): Promise<{ readonly all: readonly Record<string, unknown>[]; readonly old: readonly Record<string, unknown>[] } | null> {
  const status = await pc.fetch("/api/account/status");
  if (!status.ok) return null;
  const body: unknown = await status.json();
  if (!object(body) || body.account !== account || !Array.isArray(body.before_merge) || !body.before_merge.every((id) => typeof id === "string")) return null;
  const listing = await pc.fetch("/api/devices");
  if (!listing.ok) return null;
  const answered: unknown = await listing.json();
  if (!object(answered) || !Array.isArray(answered.devices) || !answered.devices.every(object)) return null;
  const self = answered.devices.find((row) => row.id === pc.id && row.current === true);
  if (self?.role !== "drive" || !(self.through_account === true || (self.account === account && self.account_key === pc.key))) return null;
  const rows = answered.devices.filter((row) => row.before_merge === true && typeof row.account_key === "string");
  return body.before_merge.every((id) => rows.some((row) => row.id === id)) ? { all: answered.devices, old: rows } : null;
}

/** Only an applied receipt counts. If the reply was lost, a later complete read proves absence. */
async function remove(fetch: PcFetch, key: AccountKey, account: string): Promise<boolean> {
  const record = await signAccountRecord({
    v: 1, kind: "remove", account, key: key.public_spki, signer: key.public_spki, id: newRecordId(), issued_at: new Date().toISOString(),
  }, key.private_key);
  const result: unknown = await (await post(fetch, "/api/account/records", { records: [record] })).json();
  return object(result) && Array.isArray(result.results) && result.results.some((row: unknown) => object(row) && row.id === record.id && row.outcome === "applied");
}

/**
 * A new account's driving member can remove only rows it also holds an old private key for.
 * A PC not reached, a watch row, or a refused remove leaves its work pending.
 */
export async function cleanMergedPc(context: Cleanup, pc: PcSession): Promise<void> {
  const { store, session, devices, service } = context;
  const candidates = Object.entries(await store.get("merge_keys") ?? {}).filter(([, entry]) =>
    entry.service === session.service && entry.account !== session.account
    && readSeenPcs(entry.account).pcs[pc.endpoint] !== undefined);
  if (candidates.length === 0) return;
  const [current, registered] = await Promise.all([store.key(), store.get("signin_key")]);
  if (pc.key !== current.public_spki && !(registered?.account === session.account && registered.sign_in_id === session.sign_in_id && pc.key === registered.key.public_spki)) return;
  const listing = await oldRows(pc, session.account);
  if (listing === null) return;
  const serverId = deriveServerId(hexToBytes(pc.endpoint));
  for (const [slot, entry] of candidates) {
    const keys = keysOf(entry).filter((key) => key.public_spki !== pc.key && key.public_spki !== current.public_spki && key.public_spki !== registered?.key.public_spki);
    const matched = listing.old.flatMap((row) => {
      const key = keys.find((own) => own.public_spki === row.account_key);
      return key === undefined ? [] : [{ row, key }];
    });
    let done = true;
    if (!entry.done.includes(pc.endpoint)) {
      for (const { row, key } of matched) {
        if (row.role !== "drive" || !await still(context) || !await remove(pc.fetch, key, entry.account)) done = false;
      }
    }
    if (done) {
      const saved = await devices.get(serverId);
      if (saved?.account === entry.account && saved.device_id !== null && keys.some((key) => key.public_spki === saved.public_spki)) {
        // Do not forget a saved pairing unless this read or receipt establishes that very row was cleaned.
        const old = matched.find(({ row }) => row.id === saved.device_id);
        if (old !== undefined || !listing.all.some((row) => row.id === saved.device_id)) {
          await devices.removeRow(serverId, saved.device_id, saved.public_spki);
        } else done = false;
      }
    }
    if (entry.into === undefined && matched.length === 0) await service.checkMergeKeys(slot);
    await store.update("merge_keys", (all) => {
      const live = all?.[slot];
      if (live === undefined || live.key?.public_spki !== entry.key?.public_spki || live.signIn?.key.public_spki !== entry.signIn?.key.public_spki) return all;
      return { ...all, [slot]: { ...live, ...((matched.length > 0 || (live.merged === true && live.into === undefined)) ? { into: session.account } : {}),
        ...(done && !live.done.includes(pc.endpoint) ? { done: [...live.done, pc.endpoint] } : {}) } };
    });
  }
  await settleMergeKeys(context);
}

/** A move receipt is not an account merge; only the account service's named 401 can retire the keys. */
export async function settleMergeKeys(context: Cleanup): Promise<void> {
  const { store, session, service } = context;
  for (const [slot, entry] of Object.entries(await store.get("merge_keys") ?? {})) {
    if (entry.account === session.account || entry.service !== session.service || entry.into !== session.account) continue;
    await service.checkMergeKeys(slot);
    const live = (await store.get("merge_keys"))?.[slot];
    if (live?.merged !== true || live.into !== session.account || !await still(context)) continue;
    const seen = readSeenPcs(live.account);
    await foldSeenPcs(seen, session.account);
    if (!Object.keys(seen.pcs).every((endpoint) => live.done.includes(endpoint))) continue;
    await store.updateMany(["session", "merge_keys"], (state) => {
      const latest = state.merge_keys?.[slot];
      if (state.session === undefined || !sameSignIn(state.session, session) || latest === undefined
        || latest.merged !== true || latest.into !== session.account || latest.key?.public_spki !== live.key?.public_spki
        || latest.signIn?.key.public_spki !== live.signIn?.key.public_spki) return state;
      const { [slot]: _retired, ...remaining } = state.merge_keys ?? {};
      return { ...state, merge_keys: remaining };
    });
  }
}
