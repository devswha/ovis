/**
 * The app's side of moving an account that was in use onto its signed list (docs/account-list.md, "An account that was
 * in use"; the rules are shared/account-list-migrate.ts): what this device hands the pure functions, and what it keeps
 * between the calls that make one move. The pure part takes no clock and no storage; everything here that reads either
 * says where from.
 *
 * - The PCs this device knows are its own record of them (seenPcs.ts), never the account service's directory alone,
 *   with what each PC answered IN THIS RUN of the app (PcAnswers, in memory only: an answer kept from an earlier run is
 *   none).
 * - Every time handed over is a duration: seconds by this device's clock between two of its own readings. In the QA
 *   twin build alone (QA_TWIN_APP) a person may turn the device's own waits down by a factor (migrationScale): the
 *   durations are multiplied, the pure constants never change, and a PC scales its own counters itself.
 * - The birth is signed once and kept before it is sent (KeptBirth), and sent as it is until the account service took it
 *   or refused it for good: a refusal that is final lets the device plan again, never sooner than an hour later, and
 *   without the key or the PC a `403 not_carried` named (MoveRefusal).
 */
import { linkBytes, ownEvidence, type KnownPc, type LetIn, type MigrationSeals, type PcAnswer, type PcHow } from "../../../shared/account-list-migrate.ts";
import { isListHash, isListKeyEncoding } from "../../../shared/account-list-entry.ts";
import { namesFields, type ListNames } from "../../../shared/account-list.ts";
import { epochKeyCommitment, LIST_WRAP_TEXT_LENGTH, newEpochKey, nextEpoch, sealFields, wrapToText, type EpochKey } from "../../../shared/account-list-seal.ts";
import { toBase64Url } from "../../../shared/relay-pair-sas.ts";
import type { AccountList, AccountListView } from "./accountList.ts";
import type { PlacedWrap } from "./listAnswers.ts";
import { howOf, type SeenPcs } from "./seenPcs.ts";

/** The QA twin of the phone app: the one build in which a person may turn the waits of a move down. */
export const QA_TWIN_APP = "sh.ovis.app.previewqa";
/** Where the QA twin keeps the factor its own waits are turned down by: `localStorage[MIGRATION_QA_SCALE]`, a whole number from 1 to 86400. */
export const MIGRATION_QA_SCALE = "ovis-migrate-qa-scale";
/** The largest factor: a day of waiting then passes in a second. */
export const MIGRATION_QA_SCALE_MAX = 86400;

/**
 * By how much this device multiplies the durations it hands the move's pure functions: 1, unless this build is the QA
 * twin (`app`, the application id the native app says it is) and a person set the factor there. A released app, a
 * browser and the owner's preview app always wait the full time.
 */
export function migrationScale(app: string | null, set: string | null): number {
  if (app !== QA_TWIN_APP || set === null || !/^[1-9][0-9]{0,5}$/.test(set)) return 1;
  return Math.min(MIGRATION_QA_SCALE_MAX, Number(set));
}

/** The application id the phone app says it is, once it said (nativeAppId), for migrationScale; null in a browser and until then. */
let appId: string | null = null;
export function setAppId(id: string | null): void { appId = id; }

/** This page's factor (migrationScale): the QA twin's setting, read each time it is asked. */
export function pageScale(): number {
  let set: string | null = null;
  try { set = globalThis.localStorage?.getItem(MIGRATION_QA_SCALE) ?? null; } catch { set = null; }
  return migrationScale(appId, set);
}

/** The seconds from `from` to `to`, both by this device's clock, scaled; 0 for a clock that ran back. */
export function scaled(from: number, to: number, scale: number): number {
  return Math.max(0, to - from) * scale;
}

/** What the PCs of each account answered this device in this run of the app, by relay key: an answer, or null for a PC that cannot answer. Memory only. */
export interface PcAnswers {
  get(account: string, endpoint: string): PcAnswer | null | undefined;
  set(account: string, endpoint: string, answer: PcAnswer | null): void;
  /** How many answers were heard for the account, so a caller sees that something new came. */
  count(account: string): number;
}

export function pcAnswers(): PcAnswers {
  const heard = new Map<string, Map<string, PcAnswer | null>>();
  return {
    get: (account, endpoint) => heard.get(account)?.get(endpoint),
    set(account, endpoint, answer) {
      const of = heard.get(account) ?? new Map<string, PcAnswer | null>();
      of.set(endpoint, answer);
      heard.set(account, of);
    },
    count: (account) => heard.get(account)?.size ?? 0,
  };
}

/** The answers of this page: every session it opens to a PC of the account adds to them. */
export const pageAnswers = pcAnswers();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isSpan = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const ENDPOINT = /^[0-9a-f]{64}$/;

/**
 * A PC's answer to a device of its account (`GET /api/account/list/witness`, Part F's F13), read for its form; null for
 * anything out of it. A row that is no duration is dropped, as the pure functions would drop it.
 */
export function pcAnswerOf(body: unknown): PcAnswer | null {
  if (!isRecord(body) || typeof body.account !== "string" || !(body.pinned === null || (typeof body.pinned === "string" && isListHash(body.pinned)))) return null;
  if (!Array.isArray(body.admits) || !Array.isArray(body.removed) || body.admits.length > 4096 || body.removed.length > 4096) return null;
  const admits: LetIn[] = [];
  for (const row of body.admits as readonly unknown[]) {
    if (!isRecord(row) || typeof row.key !== "string" || !isListKeyEncoding(row.key) || !isSpan(row.wall) || !isSpan(row.ran)) continue;
    admits.push({ key: row.key, wall: row.wall, ran: row.ran, idle: isSpan(row.idle) ? row.idle : null });
  }
  const removed = (body.removed as readonly unknown[]).filter((key): key is string => typeof key === "string" && isListKeyEncoding(key));
  return { account: body.account, pinned: body.pinned, admits, removed };
}

/** What this device's record says it did for a PC, as the pure part reads it: an invite the line's key proved for that PC, and the person's tap, counts as `added` (rulings-plain-invite.md, 5). */
export function pcHowOf(row: SeenPcs["pcs"][string] | undefined): PcHow {
  const how = howOf(row);
  return how === "invited" ? "added" : how;
}

/**
 * The PCs this device knows by its own record, as the move hands them over (KnownPc): what it did itself for each, for
 * how long it has held sessions with that relay key (scaled), and what the PC answered in this run. `letIn`: the relay
 * keys the account service's directory lists as let in; a PC outside it is left out (the service would refuse to carry
 * it, `403 not_carried`), and null leaves none out. `names`: what the directory calls a PC, sealed with its entry.
 */
export function knownPcs(given: {
  readonly account: string; readonly record: SeenPcs; readonly letIn: ReadonlySet<string> | null; readonly answers: PcAnswers;
  readonly names: (endpoint: string) => ListNames | null; readonly now: number; readonly scale: number; readonly skip?: ReadonlySet<string>;
}): KnownPc[] {
  const pcs: KnownPc[] = [];
  for (const [endpoint, row] of Object.entries(given.record.pcs)) {
    if (!ENDPOINT.test(endpoint) || (given.letIn !== null && !given.letIn.has(endpoint)) || given.skip?.has(endpoint) === true) continue;
    pcs.push({
      endpoint, how: pcHowOf(row), known: row.since === undefined ? null : scaled(row.since, given.now, given.scale),
      says: given.answers.get(given.account, endpoint) ?? null, names: given.names(endpoint),
    });
  }
  return pcs;
}

/** The relay keys of the PCs this device knows by its own record (ownEvidence) that have not answered in this run: the ones a move asks. */
export function pcsToAsk(given: { readonly account: string; readonly record: SeenPcs; readonly answers: PcAnswers; readonly now: number; readonly scale: number }): string[] {
  return knownPcs({ ...given, letIn: null, names: () => null }).filter((pc) => pc.says === null && ownEvidence(pc)).map((pc) => pc.endpoint);
}

/** The sealing of a birth (MigrationSeals), with the epoch keys it made and the wraps of the epoch the birth opens, for the device's own encryption key. */
export function birthSeals(): { readonly seals: MigrationSeals; readonly keys: Map<number, EpochKey>; wraps(): PlacedWrap[] } {
  const keys = new Map<number, EpochKey>();
  let wraps: PlacedWrap[] = [];
  const current = (epoch: number): EpochKey => {
    const key = keys.get(epoch);
    if (key === undefined) throw new RangeError(`No key of epoch ${epoch} was made for this birth`);
    return key;
  };
  return {
    keys, wraps: () => wraps,
    seals: {
      async genesis(names) {
        const epoch = newEpochKey(0);
        keys.set(0, epoch);
        // entry 0 has no list id yet: its place is the empty list id, and so is its commitment's
        const opens = epochKeyCommitment({ list: "", epoch });
        return { opens, sealed: names === null ? null : { epoch: 0, bytes: await sealFields({ place: { list: "", seq: 0 }, epoch, commitment: opens, fields: namesFields(names) }) } };
      },
      async names(place, epoch, names) {
        return { epoch: epoch.epoch, bytes: await sealFields({ place, epoch: current(epoch.epoch), commitment: epoch.opens, fields: namesFields(names) }) };
      },
      async next(list, epoch, members) {
        const made = await nextEpoch({ list, current: current(epoch), members });
        keys.set(made.epoch.epoch, made.epoch);
        wraps = made.wraps.map((wrap) => ({ epoch: made.epoch.epoch, member: wrap.member, wrap: wrapToText(wrap.wrap) }));
        return { opens: made.commitment, link: made.link };
      },
    },
  };
}

/**
 * The D11.2 link of a member key to the key a sign-in registered, signed by both: what a birth and a carried device's
 * hand-over carry to the account service (`link`), over linkBytes.
 */
export async function signLink(given: { readonly account: string; readonly list: string; readonly member: { readonly key: string; readonly privateKey: CryptoKey }; readonly device: { readonly key: string; readonly privateKey: CryptoKey } }): Promise<{ readonly member: string; readonly device: string }> {
  const bytes = linkBytes({ account: given.account, list: given.list, key: given.member.key, device: given.device.key });
  const by = async (key: CryptoKey): Promise<string> => toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(bytes))));
  return { member: await by(given.member.privateKey), device: await by(given.device.privateKey) };
}

const RECORD_VERSION = 1;

/**
 * A birth this device signed and has not seen placed (Part F, F2): the one request, kept before it is sent and sent as
 * it is until the account service took it (201, or `409 list_exists` naming this very list) or refused it for good.
 * `signIn` is the key that signed entry 0, the key this device's sign-in registered; `carried` names whom the run
 * carries in, for the notice after the pin; `wrap` is epoch 1's key wrapped to this device's own encryption key.
 */
export interface KeptBirth {
  readonly list: string;
  readonly signIn: string;
  readonly member: string;
  readonly entry: string;
  readonly entries: readonly string[];
  readonly wraps: readonly PlacedWrap[];
  readonly link: { readonly member: string; readonly device: string } | null;
  readonly carried: { readonly devices: readonly string[]; readonly pcs: readonly string[] };
  readonly enc: string;
  /** When it was signed, in seconds by this device's clock. */
  readonly at: number;
}

export function birthRecord(birth: KeptBirth): unknown {
  return { v: RECORD_VERSION, ...birth };
}

const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every((text) => typeof text === "string");

/** A kept birth as its record holds it; null for none or one out of form. */
export function readBirth(value: unknown): KeptBirth | null {
  if (!isRecord(value) || value.v !== RECORD_VERSION) return null;
  const { list, signIn, member, entry, entries, wraps, link, carried, enc, at } = value;
  if (typeof list !== "string" || !isListHash(list) || typeof signIn !== "string" || typeof member !== "string" || typeof entry !== "string" || typeof enc !== "string" || !isSpan(at)) return null;
  if (!texts(entries) || entries.length < 2 || !Array.isArray(wraps) || !wraps.every((wrap) => isRecord(wrap) && isSpan(wrap.epoch) && typeof wrap.member === "string" && typeof wrap.wrap === "string" && wrap.wrap.length === LIST_WRAP_TEXT_LENGTH)) return null;
  if (!(link === null || (isRecord(link) && typeof link.member === "string" && typeof link.device === "string"))) return null;
  if (!isRecord(carried) || !texts(carried.devices) || !texts(carried.pcs)) return null;
  return {
    list, signIn, member, entry, entries, wraps: wraps as PlacedWrap[], link: link === null ? null : { member: (link as { member: string }).member, device: (link as { device: string }).device },
    carried: { devices: carried.devices, pcs: carried.pcs }, enc, at,
  };
}

/** The most a device asks the account service for a birth while it waits on a final refusal: once an hour. */
export const MOVE_AGAIN_SECONDS = 3600;

/**
 * What a final refusal of a birth left: when it came (seconds, this device's clock), and the keys and PCs a `403
 * not_carried` named, which the next plan leaves out. Kept per account.
 */
export interface MoveRefusal {
  readonly at: number;
  readonly keys: readonly string[];
  readonly endpoints: readonly string[];
}

export function refusalRecord(refusal: MoveRefusal): unknown {
  return { v: RECORD_VERSION, ...refusal };
}

export function readRefusal(value: unknown): MoveRefusal | null {
  if (!isRecord(value) || value.v !== RECORD_VERSION || !isSpan(value.at) || !texts(value.keys) || !texts(value.endpoints)) return null;
  return { at: value.at, keys: value.keys, endpoints: value.endpoints };
}

/**
 * What a `403 not_carried` at `index` is about, in the birth it refused: entry 0's signer (index 0), or the key or the PC
 * the `carried` entry at that place names. The run carries the devices first, then the PCs, in the plan's order, so
 * `index - 1` is the place in it.
 */
export function notCarriedAt(birth: Pick<KeptBirth, "signIn" | "carried">, index: number | null): { readonly key: string } | { readonly endpoint: string } | null {
  if (index === null) return null;
  if (index === 0) return { key: birth.signIn };
  const place = index - 1;
  const key = birth.carried.devices[place];
  if (key !== undefined) return { key };
  const endpoint = birth.carried.pcs[place - birth.carried.devices.length];
  return endpoint === undefined ? null : { endpoint };
}

/**
 * The one-time notice after a move (R-G, F1): who made the list, and every device and PC it carried in, each with "Not
 * me". Kept until the person has seen it; `seen` once they have.
 */
export interface MoveNotice {
  readonly list: string;
  /** The key that signed entry 0 (the first device's sign-in key), and the key it handed over to. */
  readonly first: string;
  readonly devices: readonly string[];
  readonly pcs: readonly string[];
  readonly seen: boolean;
}

export function noticeRecord(notice: MoveNotice): unknown {
  return { v: RECORD_VERSION, ...notice };
}

export function readNotice(value: unknown): MoveNotice | null {
  if (!isRecord(value) || value.v !== RECORD_VERSION || typeof value.list !== "string" || !isListHash(value.list) || typeof value.first !== "string"
    || !texts(value.devices) || !texts(value.pcs) || typeof value.seen !== "boolean") return null;
  return { list: value.list, first: value.first, devices: value.devices, pcs: value.pcs, seen: value.seen };
}

/**
 * A carried device's hand-over that it signed and has not seen placed: the one signature for the head it was signed on
 * (X5), sent again as it is while the device's own copy shows that head. `refused_at`: the account service refused it
 * for good then (seconds, this device's clock): another is signed only on a new head, or an hour later.
 */
export interface KeptHandOver {
  readonly list: string;
  readonly signIn: string;
  readonly on: { readonly seq: number; readonly hash: string };
  readonly entry: string;
  readonly link: { readonly member: string; readonly device: string };
  readonly refused_at: number | null;
}

export function handOverRecord(kept: KeptHandOver): unknown {
  return { v: RECORD_VERSION, ...kept };
}

export function readHandOver(value: unknown): KeptHandOver | null {
  if (!isRecord(value) || value.v !== RECORD_VERSION) return null;
  const { list, signIn, on, entry, link, refused_at } = value;
  if (typeof list !== "string" || !isListHash(list) || typeof signIn !== "string" || typeof entry !== "string" || !isRecord(on) || !isSpan(on.seq) || typeof on.hash !== "string" || !isListHash(on.hash)) return null;
  if (!isRecord(link) || typeof link.member !== "string" || typeof link.device !== "string" || !(refused_at === null || isSpan(refused_at))) return null;
  return { list, signIn, on: { seq: on.seq, hash: on.hash }, entry, link: { member: link.member, device: link.device }, refused_at };
}

/** A request on a session with a PC, as the app's channel makes it. */
export type PcFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * What the PC behind a session answers a device of its account (`GET /api/account/list/witness`): null for a PC that
 * cannot answer (an Ovis from before this release, one in no account) or did not, which a move counts as silent.
 */
export async function askWitness(fetch: PcFetch): Promise<PcAnswer | null> {
  try {
    const answer = await fetch("/api/account/list/witness", { method: "GET", headers: { "x-herdr-machine": "1" } });
    return answer.ok ? pcAnswerOf(await answer.json()) : null;
  } catch {
    return null;
  }
}

/** Whether where the device stands waits on what its PCs answer: the start of a move, a carried device's join, or a refusal of one, which clears when its cause does. */
export function waitsOnPcs(status: AccountListView["status"]): boolean {
  return (status.at === "none" && status.why === "moving") || (status.at === "not_in" && (status.why === "carried" || status.refused !== undefined));
}

/**
 * A session the app opened to a PC of the account, for the move (Part F, F5 and F6): while the device waits on its PCs
 * this one is asked what it lets in, its answer kept for this run, and the list read again; and a device that follows
 * its moved list names it, with its vouch, to a PC that follows no list (`pinned` false: the PC took no
 * account-list-1). Nothing is said to any other PC, and nothing for an account that never moved.
 */
export async function onPcSession(given: {
  readonly list: Pick<AccountList, "view" | "naming" | "sync">; readonly answers: PcAnswers; readonly account: string; readonly fetch: PcFetch;
  readonly endpoint: string; readonly pinned: boolean; readonly session: string | null; readonly signIn: string | null;
}): Promise<void> {
  const { list, account, endpoint } = given;
  const view = list.view();
  if (view.account !== account || !ENDPOINT.test(endpoint)) return;
  if (waitsOnPcs(view.status)) {
    const said = await askWitness(given.fetch);
    given.answers.set(account, endpoint, said);
    if (said !== null) await list.sync().catch(() => undefined);
    return;
  }
  if (given.pinned || given.session === null || list.naming === undefined) return;
  const named = await list.naming({ session: given.session, endpoint, signIn: given.signIn });
  if (named === null) return;
  try {
    await given.fetch("/api/account/list/name", {
      method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
      body: JSON.stringify({ naming: named.naming, ...(named.vouches.length === 0 ? {} : { vouches: named.vouches }) }),
    });
  } catch {
    // a PC that follows no list, from before this release or away: it is named again at the next session
  }
}
