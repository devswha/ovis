/**
 * A device and the PC it has a session with say where their account's signed list stands, and each hands the other the
 * entries it lacks (docs/account-list.md, "Two members meet"): at the start of every session, whenever this device's
 * copy moves its head (a removal it just placed reaches that PC at once), and every few minutes while the session is
 * up. So a removal the account service withholds from a PC reaches it from any device of the account that opens it,
 * one it withholds from this device reaches it from such a PC, and two histories that members signed raise the alarm
 * on both sides.
 *
 * Nothing here decides who is in. What the PC answers is a page this device's own follower takes (takeFromPeer), and
 * what this device hands the PC is taken by the PC's follower: entries prove themselves. Only a PC that selected the
 * list for the session (it is pinned to its list) is asked anything, and only by a device that follows a list: an
 * account with no list, and a PC that follows none, see no request at all.
 */
import { isListHash } from "../../../shared/account-list-entry.ts";
import type { FollowRead, ListHead, ListPage, PeerAsk } from "../../../shared/account-list-follower.ts";
import type { ListPlace } from "../../../shared/account-list-signers.ts";
import type { AccountList } from "./accountList.ts";
import { AccountPcError, type PcFetch } from "./join.ts";

/**
 * How many of the two calls (POST /api/account/list/head, /page) this device makes of one PC in a minute: under the 30
 * the PC takes, which it counts by the key it let the device in by, whatever sessions the device opens.
 */
export const GOSSIP_CALLS_PER_MINUTE = 24;
/** How often, in seconds, a device says where it stands while a session is up and nothing else moved. */
export const GOSSIP_SECONDS = 300;
/** The most entries one call hands a PC (the PC takes no more). */
const PAGE_MAX = 256;
/** The most bytes of one answer of the PC that are read, an error's included: 256 entries of the longest are less. */
export const ANSWER_BYTES_MAX = 512 * 1024;
/** How long one call waits for the whole of its answer, in ms. */
export const ANSWER_MS = 10_000;
/** The longest a timer is set for at once, in ms: a longer wait is armed again in pieces. */
const ARM_MAX_MS = GOSSIP_SECONDS * 1000;

/**
 * How one exchange ended.
 *
 * - `none`: this device follows no list, or holds no entry of it: nothing was asked.
 * - `done`: both said where they stand, and what either lacked was handed over as far as it went.
 * - `alarm`: what the PC showed raised this device's alarm (two histories a member signed).
 * - `not_my_list`: the PC follows another list: nothing more is asked of it over this session.
 * - `spent`: the calls of this minute are used: the read goes on at the next exchange, from where it got to.
 * - `limited`: the PC said to wait (429), `retryAfterMs` long.
 * - `unreached`: the PC refused, did not answer, or answered out of form.
 */
export type GossipEnd = "none" | "done" | "alarm" | "not_my_list" | "spent" | "limited" | "unreached";

export interface GossipResult {
  readonly end: GossipEnd;
  /** This device's own read of the PC that is not over: the next exchange of the same session asks it, while the device stands where it stood. */
  readonly carry: GossipCarry | null;
  readonly retryAfterMs: number | null;
}

/**
 * What one exchange of a session leaves to the next, while this device stands where it stood (`on`, its head): its
 * own read of the PC that the minute's calls cut short (`read`), and the place the PC last asked for that this device
 * did not hand over yet (`asks`). Each goes on from there: a search for where two histories part ends in a bounded
 * number of exchanges, however deep the place lies.
 */
export interface GossipCarry {
  readonly on: string;
  readonly read: FollowRead | null;
  readonly asks: PeerAsk | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const placeOf = (value: unknown): ListPlace | null | undefined =>
  value === null ? null : isRecord(value) && isCount(value.seq) && typeof value.hash === "string" && isListHash(value.hash) ? { seq: value.seq, hash: value.hash } : undefined;
const askOf = (value: unknown, list: string): PeerAsk | null | undefined =>
  value === undefined || value === null ? null : isRecord(value) && value.list === list && (value.after === null || isCount(value.after)) ? { list, after: value.after } : undefined;
const headKey = (head: ListHead | null): string | null => head === null || head.place === null ? null : `${head.list}:${head.place.seq}:${head.place.hash}`;
const result = (end: GossipEnd, carry: GossipCarry | null = null, retryAfterMs: number | null = null): GossipResult => ({ end, carry, retryAfterMs });

/** An answer of the PC longer than ANSWER_BYTES_MAX: nothing of it is read past that. */
class AnswerTooLongError extends Error {
  constructor() {
    super("The PC's answer was longer than any answer of the list's session routes");
    this.name = "AnswerTooLongError";
  }
}

/** A call refused or not answered: how the exchange ends. */
function ended(error: unknown): GossipResult {
  if (error instanceof AccountPcError && error.status === 429) return result("limited", null, error.retryAfterMs ?? 60_000);
  if (error instanceof AccountPcError || error instanceof AnswerTooLongError || error instanceof TypeError || error instanceof SyntaxError
    || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))) {
    return result("unreached");
  }
  throw error;
}

/** How long and how big one answer may be (ANSWER_MS, ANSWER_BYTES_MAX); tests make them smaller. */
export interface AnswerLimits { readonly ms?: number; readonly bytes?: number }

/** The body of an answer, read up to `bytes` and until `stop` ends it, whatever the transport does with the signal. */
async function bodyOf(response: Response, bytes: number, stop: AbortSignal): Promise<string> {
  const over = new Promise<never>((_, reject) => {
    if (stop.aborted) reject(stop.reason);
    stop.addEventListener("abort", () => { reject(stop.reason); }, { once: true });
  });
  over.catch(() => {});
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await Promise.race([response.text(), over]);
    if (new TextEncoder().encode(text).byteLength > bytes) throw new AnswerTooLongError();
    return text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), over]);
      if (done) break;
      size += value.byteLength;
      if (size > bytes) throw new AnswerTooLongError();
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { whole.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder().decode(whole);
}

/**
 * One call of the two, as the account's other calls to a PC are made (join.ts `post`), with its answer held to a size
 * and a time: an answer that is longer, or does not end in time, error bodies included, ends the call. Throws the
 * PC's refusal as AccountPcError, with the wait its `retry-after` names.
 */
async function call(fetch: PcFetch, path: string, body: unknown, limits: AnswerLimits): Promise<unknown> {
  const stop = new AbortController();
  const timer = setTimeout(() => { stop.abort(new DOMException("The PC did not answer in time", "TimeoutError")); }, limits.ms ?? ANSWER_MS);
  try {
    const sent = fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body), signal: stop.signal });
    const over = new Promise<never>((_, reject) => { stop.signal.addEventListener("abort", () => { reject(stop.signal.reason); }, { once: true }); });
    over.catch(() => {});
    const response = await Promise.race([sent, over]);
    const text = await bodyOf(response, limits.bytes ?? ANSWER_BYTES_MAX, stop.signal);
    if (!response.ok) {
      let code = "http_error";
      try {
        const said = JSON.parse(text) as { error?: { code?: unknown } };
        if (typeof said.error?.code === "string" && /^[a-z_]{1,40}$/.test(said.error.code)) code = said.error.code;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      const seconds = Number(response.headers.get("retry-after") ?? Number.NaN);
      throw new AccountPcError(response.status, code, Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null);
    }
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/** How a hand-over ended: over (`done`), cut by the minute's calls with the place to go on from (`cut`), or the exchange's end. */
type Handed = { readonly done: true } | { readonly cut: PeerAsk } | { readonly failed: GossipResult };

/**
 * Hands the PC this device's entries after the place it asked for, and after each place it asks for next, while
 * `spend` allows a call: a later one where it took a page in part and wants the rest (`more`), an earlier one where it
 * looks for where two histories part. Over when the PC stands at this device's last signed entry, asks for a place it
 * was handed already in this hand-over, asks for nothing more, or refused a page. Cut by the budget, it says the
 * place the PC asked for, and the next exchange goes on from there.
 */
async function handOver(fetch: PcFetch, list: AccountList, first: PeerAsk, spend: () => boolean, limits: AnswerLimits): Promise<Handed> {
  const mine = list.gossip();
  if (mine === null || mine.place === null || first.list !== mine.list) return { done: true };
  const target = mine.place.seq;
  const handed = new Set<number | null>();
  let after = first.after;
  for (;;) {
    if ((after !== null && after >= target) || handed.has(after)) return { done: true };
    const page = list.pageAfter(after, PAGE_MAX);
    // a copy replaced meanwhile, or nothing after that place: nothing is handed over this time
    if (page === null || page.list !== mine.list || page.entries.length === 0) return { done: true };
    if (!spend()) return { cut: { list: mine.list, after } };
    handed.add(after);
    let said: unknown;
    try { said = await call(fetch, "/api/account/list/page", page, limits); } catch (error) { return { failed: ended(error) }; }
    if (!isRecord(said)) return { failed: result("unreached") };
    const asks = askOf(said.asks, mine.list);
    // the PC wants another place: that page goes next, in either direction, unless it was handed already
    if (asks !== null && asks !== undefined) {
      after = asks.after;
      continue;
    }
    // where the PC stands now, when it is a place of this device's own history; a page it did not take ends it
    const stands = placeOf(said.place);
    if (said.verdict !== "caught_up" && said.verdict !== "more") return { done: true };
    if (stands === undefined || stands === null || list.placeAt(stands.seq)?.hash !== stands.hash || (after !== null && stands.seq <= after)) return { done: true };
    after = stands.seq;
  }
}

/**
 * One exchange over a session with a PC that follows the account's list: this device says where it stands; what the
 * PC answers of its own is taken by this device's follower, and what it asks for is handed to it, once an exchange.
 * Where this device needs the PC's entries after another place (the PC holds more, or another entry at a place this
 * device holds, or it looks for where two histories part), it asks the PC for them (`asks`), as often as `spend`
 * allows a call. What the calls did not finish goes on at the next exchange (GossipCarry).
 */
export async function gossipWithPc(fetch: PcFetch, list: AccountList, carried: GossipCarry | null, spend: () => boolean, limits: AnswerLimits = {}): Promise<GossipResult> {
  const start = list.gossip();
  const on = headKey(start);
  if (start === null || on === null) return result("none");
  const kept = carried !== null && carried.on === on ? carried : null;
  let read: FollowRead | null = kept?.read?.list === start.list ? kept.read : null;
  let handed = false;
  // a hand-over the last exchange's calls cut short goes on first, where the PC left off
  if (kept?.asks != null) {
    const going = await handOver(fetch, list, kept.asks, spend, limits);
    if ("failed" in going) return going.failed;
    if ("cut" in going) return result("spent", { on, read, asks: going.cut });
    handed = true;
  }
  let alarm = false;
  for (;;) {
    const mine = list.gossip();
    const here = headKey(mine);
    if (mine === null || mine.place === null || here === null) return result("none");
    if (!spend()) return result("spent", read === null ? null : { on: here, read, asks: null });
    let said: unknown;
    try {
      said = await call(fetch, "/api/account/list/head", { list: mine.list, place: mine.place, ...(read === null ? {} : { asks: { list: read.list, after: read.after } }) }, limits);
    } catch (error) { return ended(error); }
    if (!isRecord(said) || typeof said.list !== "string") return result("unreached");
    if (said.list !== mine.list) return result("not_my_list");
    const place = placeOf(said.place);
    const asks = askOf(said.asks, mine.list);
    if (place === undefined || asks === undefined) return result("unreached");
    let next: FollowRead | null = null;
    if (isRecord(said.page)) {
      // the PC's own entries, for this device's follower to judge: they prove themselves or count for nothing
      const took = await list.takeFromPeer(said.page as unknown as ListPage, read);
      if (took === null) return result("none");
      if (took.verdict === "fork") alarm = true;
      // a page that could not be saved is acted on, and asked for again at the next exchange rather than read on from
      next = took.saved ? took.read : null;
    } else if (read === null) {
      // the PC answered no page: where it holds more, or another entry at a place this device holds, this device asks
      const compared = list.compare({ list: said.list, place });
      next = compared !== null && (compared.verdict === "behind" || compared.verdict === "differs") ? compared.read : null;
    }
    // what the PC lacks, it asks for: this device hands it over, once an exchange
    if (asks !== null && !handed) {
      handed = true;
      const going = await handOver(fetch, list, asks, spend, limits);
      if ("failed" in going) return going.failed;
      const now = headKey(list.gossip()) ?? here;
      if ("cut" in going) return result(alarm ? "alarm" : "spent", { on: now, read: next, asks: going.cut });
    }
    if (alarm) return result("alarm");
    // asked, and answered nothing of it (a PC from before this question): it is not asked again this time
    if (next === null || (read !== null && !isRecord(said.page))) return result("done");
    read = next;
  }
}

/**
 * The calls this device may still make of one PC, and the wait that PC asked for (a 429), for one key the PC let it in
 * by: the PC counts its 30 a minute by that key, whatever sessions, tabs or reopenings the device signs in with, so
 * they all draw on one budget.
 */
export interface GossipBudget {
  /** One more call now, where the minute has room and no wait the PC asked for runs: true, and it is counted. */
  spend(): boolean;
  /** The PC asked this device to wait `ms` before it calls again. */
  pause(ms: number): void;
  /** How long, in ms, until a call may go: 0 for at once. */
  wait(): number;
}

interface BudgetRecord { calls: number[]; until: number }

/** What the page keeps of each budget while its own storage holds none (a page with no localStorage): one record a key. */
const budgets = new Map<string, BudgetRecord>();
const BUDGET_PREFIX = "ovis-list-gossip:";
/** The longest wait a PC's `retry-after` is taken for, in ms. */
const PAUSE_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * The budget of the key `key` names (a PC and the key it let this device in by), shared with every tab of this browser
 * through `storage` (localStorage by default) and with every reopening of the PC in this page. Times are the wall
 * clock, the one clock the tabs share: a call or a wait that stands further ahead of it than it could have been made
 * is dropped, so a clock set back holds nothing back for long.
 */
export function gossipBudget(key: string, options: { readonly perMinute?: number; readonly storage?: Pick<Storage, "getItem" | "setItem"> | null; readonly now?: () => number } = {}): GossipBudget {
  const now = options.now ?? Date.now;
  const perMinute = options.perMinute ?? GOSSIP_CALLS_PER_MINUTE;
  const storage = options.storage !== undefined ? options.storage : (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
  const name = BUDGET_PREFIX + key;
  const read = (at: number): BudgetRecord => {
    let held: unknown = budgets.get(name);
    if (storage !== null) {
      try { held = JSON.parse(storage.getItem(name) ?? "null"); } catch { held = null; }
    }
    const record = typeof held === "object" && held !== null ? held as Partial<BudgetRecord> : {};
    const calls = Array.isArray(record.calls) ? record.calls.filter((made): made is number => typeof made === "number" && made > at - 60_000 && made <= at + 60_000) : [];
    const until = typeof record.until === "number" && record.until > at && record.until <= at + PAUSE_MAX_MS ? record.until : 0;
    return { calls, until };
  };
  const write = (record: BudgetRecord): void => {
    budgets.set(name, record);
    if (storage === null) return;
    try { storage.setItem(name, JSON.stringify(record)); } catch { /* the page's own record stands */ }
  };
  return {
    spend() {
      const at = now();
      const record = read(at);
      if (record.until > at || record.calls.length >= perMinute) return false;
      write({ calls: [...record.calls, at], until: record.until });
      return true;
    },
    pause(ms) {
      const at = now();
      const record = read(at);
      write({ calls: record.calls, until: Math.max(record.until, at + Math.min(Math.max(0, ms), PAUSE_MAX_MS)) });
    },
    wait() {
      const at = now();
      const record = read(at);
      const full = record.calls.length >= perMinute ? Math.min(...record.calls) + 60_000 - at : 0;
      return Math.max(0, record.until - at, full);
    },
  };
}

/** How long a device that learnt that the PC it has open was put out of the list tries to hand that PC the removal, in ms. */
export const REMOVAL_DELIVERY_MS = 3_000;

/**
 * One bounded exchange over a session the app no longer uses itself: the PC it had open was put out of the account's
 * list, and this device hands that PC the removal over the session it still has, so the PC knows itself out even where
 * the account service withholds it. Over within `ms` whatever the PC does; the caller then closes the session.
 */
export async function deliverOnce(session: GossipSession, list: AccountList | null, budget: GossipBudget, ms = REMOVAL_DELIVERY_MS): Promise<void> {
  if (list === null || session.followsList !== true || session.route === undefined || list.gossip() === null) return;
  const end = new AbortController();
  const timer = setTimeout(() => { end.abort(new DOMException("The PC took too long to be handed its removal", "TimeoutError")); }, ms);
  const over = new Promise<void>((resolve) => { end.signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
  const fetch: PcFetch = (input, init) => session.fetch(input, { ...init, signal: init?.signal == null ? end.signal : AbortSignal.any([init.signal, end.signal]) });
  try {
    await Promise.race([gossipWithPc(fetch, list, null, () => !end.signal.aborted && budget.spend(), { ms }).then(() => undefined, () => undefined), over]);
  } finally {
    clearTimeout(timer);
  }
}

/** A session with a PC as this module needs it: the relay transport the app opened. */
export interface GossipSession {
  /** The PC selected the account's list for this session: it is pinned to its list. */
  readonly followsList?: boolean | undefined;
  /** A carrier is up: undefined while the session reconnects. */
  readonly route?: "relay" | "direct" | undefined;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  onRouteChange?(listener: () => void): () => void;
}

export interface KeepGossipOptions {
  /** This page's copy of its account's list, read at every turn: null while there is none. */
  readonly list: () => AccountList | null;
  /** Whether the session is still the one the app has open: once it is not, everything here stops. */
  readonly live?: () => boolean;
  /** A clock that only moves forward, in ms. */
  readonly mono?: () => number;
  /**
   * What this session's calls draw on: the PC's and the admitted key's own (gossipBudget), shared with every tab and
   * reopening that signs in to that PC with that key. One of its own by default.
   */
  readonly budget?: GossipBudget;
  /** The calls of a minute of a budget of its own: GOSSIP_CALLS_PER_MINUTE. */
  readonly callsPerMinute?: number;
  /** How long and how big one answer may be. */
  readonly limits?: AnswerLimits;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

/**
 * Keeps one session's exchanges (gossipWithPc) going until the returned stop is called or the session is no longer
 * live: at once, at every new carrier of the session (each is a new session at the PC), whenever this device's copy
 * moves its head, and every GOSSIP_SECONDS. One exchange at a time; one asked for meanwhile runs after it. A session
 * whose PC does not follow the list, and a device that follows none, are asked nothing.
 */
export function keepListGossip(session: GossipSession, options: KeepGossipOptions): () => void {
  const mono = options.mono ?? (() => performance.now());
  // a page that is closing is not held open by the next turn
  const setTimer = options.setTimer ?? ((run, ms) => { const timer = setTimeout(run, ms); (timer as { unref?: () => void }).unref?.(); return timer; });
  const clearTimer = options.clearTimer ?? ((timer) => { clearTimeout(timer as ReturnType<typeof setTimeout>); });
  let stopped = false;
  let running = false;
  let again = false;
  let carry: GossipCarry | null = null;
  let otherList = false;
  let up = session.route !== undefined;
  let watched: AccountList | null = null;
  let unwatch: (() => void) | null = null;
  let lastHead: string | null = null;
  let timer: unknown = null;

  // a budget of its own counts by the session's clock that only moves forward
  const budget = options.budget ?? gossipBudget(`own:${Math.random()}`, { perMinute: options.callsPerMinute ?? GOSSIP_CALLS_PER_MINUTE, storage: null, now: mono });
  const spend = (): boolean => budget.spend();
  // a long wait is armed in pieces: each turn looks at the budget again, and no timer is set past what a browser holds
  const arm = (ms: number): void => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; turn(); }, Math.min(Math.max(0, ms), ARM_MAX_MS));
  };
  // the page's list is read at every turn: one made after this session began is watched from then on
  const watch = (): AccountList | null => {
    const list = options.list();
    if (list !== watched) {
      unwatch?.();
      watched = list;
      lastHead = headKey(list?.gossip() ?? null);
      unwatch = list?.subscribe(() => {
        const head = headKey(list.gossip());
        if (head !== lastHead) { lastHead = head; turn(); }
      }) ?? null;
    }
    return list;
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    unwatch?.();
    offRoute?.();
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const turn = (): void => {
    if (stopped) return;
    if (options.live?.() === false) { stop(); return; }
    const list = watch();
    if (session.followsList !== true || session.route === undefined || otherList || list === null || list.gossip() === null) { arm(GOSSIP_SECONDS * 1000); return; }
    if (running) { again = true; return; }
    const wait = budget.wait();
    if (wait > 0) { arm(wait); return; }
    running = true;
    let left = false;
    void gossipWithPc((input, init) => session.fetch(input, init), list, carry, spend, options.limits).then((result) => {
      carry = result.carry;
      if (result.end === "not_my_list") otherList = true;
      if (result.end === "limited") budget.pause(result.retryAfterMs ?? 60_000);
      // what the calls of this minute did not finish goes on as soon as the budget has room, not at the next timer
      left = result.end === "spent";
    }, (error: unknown) => {
      console.warn("Ovis: the account's list was not compared with this PC", error instanceof Error ? error.name : error);
    }).finally(() => {
      running = false;
      if (stopped) return;
      if (again) { again = false; turn(); return; }
      const wait = budget.wait();
      arm(left || wait > 0 ? wait : GOSSIP_SECONDS * 1000);
    });
  };
  // a carrier that comes up again is a new session at the PC: what was asked over the last one starts afresh. Its
  // calls do not: the PC counts them by this device's key, so a new carrier is no new minute
  const offRoute = session.onRouteChange?.(() => {
    const now = session.route !== undefined;
    if (now && !up) { carry = null; otherList = false; up = now; turn(); return; }
    up = now;
  });
  turn();
  return stop;
}
