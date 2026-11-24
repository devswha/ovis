/**
 * Test support only: nothing in production imports it (server/conventions.test.ts).
 * It checks what the real service must check (record shape and signature, the caller's directory,
 * server proof with the `account` role), so tests fail where a PC or app relies on something the
 * service would refuse.
 */
import {
  ACCOUNT_RECORDS_MAX, AccountRecordError, isAccountKeyEncoding, isDeviceSafetyRecord, parseSafetyRecord, readAccountRecord, verifySafetyRecord,
  type AccountRecord, type BlockRecord, type DeviceLiftRecord, type SafetyRecord,
} from "./account-records.ts";
import { ACCOUNT_SNAPSHOT_V, SNAPSHOT_GONE, type AccountSnapshotPage, type SnapshotFreezeLine } from "./account-snapshot.ts";
import { ListEntryError, entryFromText, entryHash, entryHolds, entryToText, firstState, isListHash, isListKeyEncoding, readBody, verifySignature, type Entry, type EntryBody, type HeldEntry } from "./account-list-entry.ts";
import { oneSpelling } from "./account-list-join.ts";
import { CARD_SIGNATURE_CHARS, ListKindError, cardHolds, firstListState, holdsPc, isListKey, readKind, takeEntry, wrapKeys, type ListState } from "./account-list.ts";
import { signerPower, type ListPlace } from "./account-list-signers.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";
import { accountOsOf, type AccountOs, type AccountPlace } from "./account-asker.ts";
import { isWssOrigin } from "./relay-offer.ts";
import { deriveServerId, proofKey, serverChallenge, verifyServerProof } from "./relay-server-proof.ts";

export const CHALLENGE_TTL_MS = 60_000;
/** How long a PC's own leave (POST /v1/pcs/{server_id}/leave) keeps a PUT without its proof from listing it again. */
export const PC_LEFT_MS = 30 * 24 * 60 * 60 * 1000;

/** a listing's own ID (account#57), as the service makes it */
const LISTING_ID = /^[0-9a-f]{32}$/;

/** account#57's completion scope, and the context its challenge is stored and proved under */
function completionScope(value: unknown): { account: string; listing_id: string } | null {
  if (value === null || typeof value !== "object") return null;
  const { account, listing_id } = value as Record<string, unknown>;
  return Object.keys(value).length === 2 && typeof account === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(account) && typeof listing_id === "string" && LISTING_ID.test(listing_id)
    ? { account, listing_id } : null;
}
const completionKey = (scope: { account: string; listing_id: string }, nonce: string): string => `pc-complete/1:${scope.account}:${scope.listing_id}:${nonce}`;
export const MAILBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAILBOX_PAGE = 100;
export const MAILBOX_MAX = 1000;
export const ACCESS_TOKEN_TTL_S = 3600;
export const DIRECTORY_MAX = 100;
export const LIMIT_WINDOW_MS = 10 * 60_000;
export const ADMISSIONS_PER_WINDOW = 10;
/** Quiet admissions one account may post in a window: a count of their own, apart from the ordinary ones. */
export const QUIET_ADMISSIONS_PER_WINDOW = 60;
export const ACCOUNT_REQUESTS_PER_WINDOW = 600;
export const DEVICE_CODE_TTL_S = 900;
export const DEVICE_POLL_S = 5;
export const ACCOUNT_RING = { pane_id: null, title: "Ovis", body: "Your Ovis account has news", tag: "ovis-account" } as const;

export interface FakeRing { account: string; endpoint: string; payload: typeof ACCOUNT_RING }
export const SIGNIN_CODE_TTL_MS = 60_000;

export type SignInProvider = "github" | "google" | "apple";
const SIGN_IN_PROVIDERS: readonly string[] = ["github", "google", "apple"];
const DEVICE_PAGES: Readonly<Record<string, string>> = { github: "https://github.com/login/device", google: "https://www.google.com/device" };
export const LINK_TOKEN_TTL_S = 600;
/** How recent a sign-in must be to add or remove a sign-in method. */
export const REAUTH_MS = 10 * 60_000;

/** The web app's redirect: the code comes back in the fragment there, so it never reaches the host's logs. */
export const WEB_REDIRECT = "https://app.ovis.sh/";

/** The only redirects sign-in returns to (docs/account.md, "Signing in"), compared exactly. */
export function isAllowedRedirect(uri: string): boolean {
  if (uri === WEB_REDIRECT || uri === "ovis://account/callback") return true;
  const loopback = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/callback$/.exec(uri);
  return loopback !== null && Number(loopback[1]) >= 1 && Number(loopback[1]) <= 65535;
}

async function sha256Hex(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;

interface Session { account: string; provider: SignInProvider | "test"; family: string; expires: number }

/** `public_key`: the PC's relay key (X25519, 64 hex), from which `server_id` derives; `relay`: the wss origin it is reached through. */
export interface FakePc { server_id: string; label: string; public_key: string; relay: string; added_at: string; last_seen_at: string | null; new_until?: string | null; admitted_at?: string | null; exempt?: boolean;
  /** PCL-1: listed by a sign-in that was no app's own (a device code) and not confirmed since, as the service's `listed_by_device` */
  listed_by_device?: boolean;
  /** listed by a device code while Step 2 was on: until confirmed or admitted it leaves the account never used (account#62) */
  pending_under_step2?: boolean;
  /** the sign-in (family) that wrote the listing, as the service's `listed_by_session` (account#63): upkeep never rewrites it */
  listed_by_session?: string;
  /** with `completions` (account#57): this listing's own ID */
  listing_id?: string;
  /** the PC completed its add (the service's `completed_at`; with `completions`, POST /v1/pc/complete), and a device was admitted to it by its digits (`digit_admitted`) */
  completed_at?: string | null;
  digit_admitted?: boolean }
/** How long a PC added in one press stays new to the account's other devices. */
export const PC_NEW_MS = 24 * 60 * 60_000;
/** One-press PC adds one account may make per rolling day; past it 429 `pc_add_cap`. */
export const PC_ADMITS_PER_DAY = 3;
/** `key`: the waiting device's account key, which the PC matches against the comparison it is asked for. */
export interface FakeAdmission { id: string; server_id: string; account: string; label: string; key: string; at: string; os: AccountOs | null; country: string | null; city: string | null }
/** How long an admission reaches its PC's mailbox: the PC lets a waiting account device compare digits only within it. */
export const ADMISSION_TTL_MS = 10 * 60_000;

interface Mail { seq: number; record: AccountRecord; at: number }

/** Devices one snapshot page lists. */
export const SNAPSHOT_PAGE = 100;

/** Device table P6, P21: an account's registered keys, each with a `no` that is never reused, and its durable records. */
interface Registry {
  next: number;
  version: number;
  /** Device table T58: raised when the account gains or loses a sign-in method */
  methods_version: number;
  devices: Map<string, { no: number; label: string; eligible: boolean; removed: boolean }>;
  blocks: BlockRecord[];
  lifts: DeviceLiftRecord[];
  freezes: SnapshotFreezeLine[];
}

type SnapshotState = Omit<AccountSnapshotPage, "page" | "last" | "v">;

/**
 * The limits of the signed list's routes (/v2, docs/development.md "The account service's list routes"), as the
 * service has them. Each instance copies them into `listLimits`, where a test may lower one.
 */
export const LIST_LIMITS = {
  /** From this `seq` on, only `remove` and `epoch` are placed (409 `list_full`). */
  removalsOnlyFrom: 16384,
  /** From this `seq` on, nothing is placed. */
  closedFrom: 20480,
  /** Past this many characters of the service's own state of the list as JSON, only `remove` and `epoch` are placed. */
  stateChars: 1024 * 1024,
  /** Additions (`device`, `pc`, `invite`, `join`) one list takes in any ten minutes (429 `entry_budget`). */
  additionsPerWindow: 60,
  /** Batches whose every entry is a `remove`, by one signer of the list, in ten minutes: they spend this, not the account's requests. */
  removalsPerWindow: 120,
  /** Calls of the list routes one proven PC makes in a minute (the service's MACHINE_LIMITER). */
  pcCallsPerMinute: 30,
};
/** How long a device's claim (POST /v2/lists/{list}/claims) and a PC's post of its keys (POST /v2/pc/list/keys) last. */
export const LIST_CLAIM_MS = 10 * 60_000;
/** Entries one log page holds at most, and about how much text. */
export const LIST_PAGE_MAX = 256;
export const LIST_PAGE_CHARS = 1024 * 1024;
/** Entries and wraps one placement carries at most. */
export const LIST_BATCH_MAX = 16;
export const LIST_WRAPS_MAX = 1024;
/** How far an `invite`'s `issued_at` may lie ahead of the service's clock, in seconds. */
export const LIST_ISSUED_AHEAD_S = 300;
/** Body limits of the list routes, in bytes. */
const LIST_BODY = { genesis: 32 * 1024, entries: 512 * 1024, small: 8 * 1024 } as const;
/** A wrap as text: 151 base64url characters, the 113 bytes of Part C's wrap. */
const WRAP_TEXT = 151;
const WRAP_BYTES = 113;
/** The purposes of the key proof (`ovis-pc-add/1`) that the list routes take, and the challenge's life (as POST /v1/pcs/challenge). */
type ListKeyProofPurpose = "list-genesis" | "list-claim";
export const PC_ADD_CHALLENGE_TTL_MS = 2 * 60_000;

/**
 * Whom a tamper rule lies to: a device by the sign-in of its token (a refresh keeps it), a PC by its server_id.
 * A rule without one lies to every reader.
 */
export type ListReader = { readonly token: string } | { readonly server_id: string };

/** A wrap as the list routes carry it. */
export interface ListWrap { readonly epoch: number; readonly member: string; readonly wrap: string }

/**
 * The lies a test makes the fake's list routes tell, for one list (`tamperList`). Nothing is on by default, and a
 * lie changes only what is served or refused: the log the service holds stays as placed. Each field names what a
 * member must survive.
 */
export interface ListTamper {
  /** Lie to this reader only; to every reader when left out. For `headMoved` and `dropWraps` it is the placer. */
  readonly reader?: ListReader;
  /** These texts are served after the log as if placed, the head moved to the last: an entry of a key that is no member is passed over (loose), never let in. */
  readonly inject?: readonly string[];
  /** These wraps are served in place of the stored ones for their member and epoch: a wrap to a key of the service's own does not match the chain's `epoch_opens` (`other_key`). */
  readonly wraps?: readonly ListWrap[];
  /** The log ends at this seq for the reader, its head with it: a removal after it never arrives, which only head gossip or a direct push can tell. */
  readonly withholdAfter?: number;
  /** Every answer reports this head (the log, which list, the mailbox): one the log does not reach shows the tail withheld; an old one is a hint that changes nothing. */
  readonly head?: ListPlace;
  /** The log is served with these texts in place of its own from the first one's seq on: two readers given two forks each hold a valid member-signed history, which only head gossip parts. */
  readonly fork?: readonly string[];
  /** Pages end after these seqs, `more` true: a reader that asks again `after` its last seq joins the same log whatever the cuts. */
  readonly pages?: readonly number[];
  /** This other list (another account's) is answered for this one, under this one's id: its entry 0 does not hash to the id the member pinned. */
  readonly answerList?: string;
  /** One byte of the body of the entry at this seq is flipped as served: it no longer holds (`signature_invalid`, or `entry_malformed`). */
  readonly flipEntry?: { readonly seq: number; readonly byte?: number };
  /** One byte of this member's wrap of this epoch is flipped as served: it does not open (`refused`), which is no evidence. */
  readonly flipWrap?: { readonly member: string; readonly epoch: number; readonly byte?: number };
  /** Every placement is refused 409 `head_moved` with the true head, forever: a writer stops after its own bound and says so. */
  readonly headMoved?: boolean;
  /** A placed batch's entries are stored and its wraps dropped: the new member sees no names, and is let in all the same. */
  readonly dropWraps?: boolean;
}

/** A device's claim of its member key, by the sign-in (family) that took it at `at`. */
interface ListClaim { readonly family: string; readonly enc: string; readonly card: string; readonly at: number }
/** A PC's post of its keys, taken at `at`. */
interface ListPost { readonly server_id: string; readonly key: string; readonly enc: string; readonly card: string; readonly at: number }

/** A list as the service holds it: every entry as the text it was sent, its own state of the list (never served), wraps, claims and posts. */
interface FakeList {
  readonly id: string;
  readonly account: string;
  readonly texts: string[];
  readonly hashes: string[];
  last: HeldEntry;
  state: ListState;
  /** by member, then epoch: one wrap each, written once */
  readonly wraps: Map<string, Map<number, string>>;
  /** by the claimed key: one per key, and one per sign-in */
  readonly claims: Map<string, ListClaim>;
  /** by endpoint */
  readonly posts: Map<string, ListPost>;
  /** when each addition was placed, for the entry budget */
  readonly additions: number[];
  readonly tamper: { readonly rule: ListTamper; readonly family: string | null; readonly server_id: string | null }[];
}

/** Who reads or places: a device's sign-in, or a PC by its server_id and endpoint (its relay key). */
type ListCaller = { readonly family: string; readonly server_id?: undefined; readonly endpoint?: undefined } | { readonly family?: undefined; readonly server_id: string; readonly endpoint: string };

export class FakeAccountService {
  private readonly tokens = new Map<string, Session>();
  /** `link`: the sign-in (account and refresh family) a linking sign-in adds this identity to, once that sign-in redeems the code */
  private readonly codes = new Map<string, { account: string; provider: SignInProvider; challenge: string; redirect: string; expires: number; link: { account: string; family: string } | null }>();
  private readonly refreshTokens = new Map<string, { account: string; provider: SignInProvider; family: string; used: boolean }>();
  private readonly revokedFamilies = new Set<string>();
  private readonly appleTokens = new Map<string, { account: string; nonce: string }>();
  private readonly signIns = new Map<SignInProvider, string>();
  private readonly deviceSignIns = new Map<string, { provider: SignInProvider; userCode: string; account: string | null; denied: boolean; interval: number; nextPoll: number; expires: number; challenge: string | null; page?: boolean; requester?: { label: string | null; os: AccountOs | null } }>();
  private readonly identityList = new Map<string, Map<SignInProvider, { added_at: string }>>();
  private readonly linkTokens = new Map<string, { account: string; family: string; provider: SignInProvider; expires: number }>();
  /** by refresh family: when that sign-in was made (a refresh keeps it), for what needs a recent one */
  private readonly signedInAt = new Map<string, number>();
  /** by refresh family: the sign-in's two_step_set (null: unknown, as a Google sign-in without amr) */
  private readonly twoStep = new Map<string, boolean | null>();
  /** what a sign-in made through the sign-in routes says of two-step sign-in; tests set it */
  signInTwoStep: boolean | null = null;
  /** one-press admissions by account and PC (`box`), and each account's admit times, for the daily cap */
  private readonly pcAdmissions = new Map<string, { at: number; taken: boolean; family: string; listing?: string }>();
  private readonly admitTimes = new Map<string, number[]>();
  /** accounts that admitted or removed a PC: never empty again for the first-PC exemption */
  private readonly usedAccounts = new Set<string>();
  /** by refresh family: when that sign-in registered its own account device key (registerSessionKey) */
  private readonly keyRegisteredAt = new Map<string, number>();
  /** by key: the refresh family that registered it with registerSessionKey */
  private readonly keyFamily = new Map<string, string>();
  private offered: { providers: SignInProvider[]; device: SignInProvider[]; device_page?: SignInProvider[] } = { providers: ["github", "google", "apple"], device: ["github", "google"] };
  private readonly pushes = new Map<string, { account: string; endpoint: string }>();
  private readonly counters = new Map<string, { start: number; count: number }>();
  private readonly ringList: FakeRing[] = [];
  private readonly directories = new Map<string, Map<string, FakePc>>();
  private readonly mailboxes = new Map<string, Mail[]>();
  private readonly challenges = new Map<string, { server_id: string; expected: string; expires: number }>();
  /** box(server_id, account): when the PC left that account by its own proof */
  private readonly pcLeaves = new Map<string, number>();
  private readonly admissionList: FakeAdmission[] = [];
  /** quiet admissions: only an app's own sign-in posts one, and only a PC the account lists reads them */
  private readonly quietList: FakeAdmission[] = [];
  private readonly accountLimits = new Map<string, Record<string, unknown>>();
  private readonly subscribed = new Set<string>();
  private readonly deletedAccounts = new Set<string>();
  /** sign-ins made with a device code or on the link page, refreshes included: they cannot delete the account */
  private readonly deviceFamilies = new Set<string>();
  /** Where the service sees every request come from (Cloudflare's `request.cf`); unknown unless a test says. */
  requestPlace: AccountPlace = { country: null, city: null };
  linkPageAcceptsLabelAndOs = true;
  private readonly registries = new Map<string, Registry>();
  private readonly snapshots = new Map<string, SnapshotState>();
  /** OVIS_ACCOUNT_OPENS_ALL at the service: off, the snapshot and safety-record routes do not exist. */
  opensAll = false;
  /** Newer services distinguish a listed PC's snapshot opt-out from a hidden 404. */
  reportsStep2Off = false;
  /**
   * account#57: each listing has its own ID; a PC's admission may name it (`with_listing_id`), and the PC, once bound,
   * records its add complete with a proof scoped to that account and listing (POST /v1/pc/complete). Off: an older service,
   * which a PC no longer binds to in one press.
   */
  completions = true;
  /**
   * The mailbox says beside `listing_id` whether that listing stands on a one-press admission this PC took
   * (`listing_admitted`). Off: a service from before the field, which omits it.
   */
  saysListingAdmitted = true;
  /**
   * The one-press admit asks a used account's sign-in for two-step (`two_step_required`), as the service did until
   * 2026-11-23. Off, the service since: such an admit is logged as exempt instead.
   */
  admitAsksTwoStep = false;
  private seq = 0;
  readonly requests: string[] = [];
  /**
   * OVIS_LIST_ACCOUNTS at the service: account ids separated by commas, or the one entry `*` for every account. For an
   * account it does not name, every /v2 route answers as an unknown one and the mailbox's `with_list` says `list: null`;
   * its list is kept. Empty, as the service ships: no account.
   */
  listAccounts = "";
  /** LIST_LIMITS, for this instance: a test lowers one to reach it. */
  readonly listLimits = { ...LIST_LIMITS };
  private readonly lists = new Map<string, FakeList>();
  /** by account: its one list's id */
  private readonly accountLists = new Map<string, string>();
  /** POST /v1/pcs/challenge's challenges, by id: for one sign-in (family), spent by their first use */
  private readonly pcAddChallenges = new Map<string, { family: string; challenge: string; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `device`: the token is a device code's sign-in (a PC's), never an app's own */
  issueToken(account: string, { twoStep = null, device = false }: { twoStep?: boolean | null; device?: boolean } = {}): string {
    const token = randomHex(32);
    const family = randomHex(16);
    this.tokens.set(token, { account, provider: "test", family, expires: Number.POSITIVE_INFINITY });
    this.signedInAt.set(family, this.now());
    this.twoStep.set(family, twoStep);
    if (device) this.deviceFamilies.add(family);
    return token;
  }

  setLimits(account: string, limits: Record<string, unknown> | null): void {
    if (limits === null) this.accountLimits.delete(account);
    else this.accountLimits.set(account, limits);
  }

  signInAs(provider: SignInProvider, account: string): void { this.signIns.set(provider, account); }

  subscribe(account: string, renews = true): void { if (renews) this.subscribed.add(account); else this.subscribed.delete(account); }

  deleted(account: string): boolean { return this.deletedAccounts.has(account); }

  offerSignIns(providers: SignInProvider[], device: SignInProvider[]): void { this.offered = { providers, device }; }

  offerLinkPage(providers: SignInProvider[]): void { this.offered = { ...this.offered, device_page: providers }; }

  linkRequester(userCode: string): { label: string | null; os: AccountOs | null } | undefined {
    for (const entry of this.deviceSignIns.values()) if (entry.page && entry.userCode === userCode) return entry.requester;
    return undefined;
  }

  approveOnLinkPage(userCode: string, account: string, provider: SignInProvider): void {
    // one approval, as the service: an approved request's code names nothing any more
    for (const entry of this.deviceSignIns.values()) {
      if (entry.userCode === userCode && entry.page && entry.account === null && this.now() < entry.expires) { entry.account = account; entry.provider = provider; entry.userCode = ""; }
    }
  }


  private addIdentity(account: string, provider: SignInProvider): void {
    const methods = this.identityList.get(account) ?? new Map();
    if (!methods.has(provider)) { methods.set(provider, { added_at: this.iso() }); this.methodsChanged(account); }
    this.identityList.set(account, methods);
  }

  /** An identity token as Sign in with Apple hands an iOS app, for `account`, whose `nonce` claim is the hash the app gave Apple. */
  appleIdToken(account: string, nonceHash: string): string {
    const token = randomHex(32);
    this.appleTokens.set(token, { account, nonce: nonceHash });
    return token;
  }

  approveDevice(userCode: string, account: string): void {
    for (const entry of this.deviceSignIns.values()) if (entry.userCode === userCode) entry.account = account;
  }

  denyDevice(userCode: string): void {
    for (const entry of this.deviceSignIns.values()) if (entry.userCode === userCode) entry.denied = true;
  }

  rings(): readonly FakeRing[] { return this.ringList; }

  private ring(account: string, family: string): void {
    for (const [owner, push] of this.pushes) if (push.account === account && owner !== family) this.ringList.push({ account, endpoint: push.endpoint, payload: ACCOUNT_RING });
  }

  private withinRateLimit(key: string, max: number): boolean {
    const now = this.now();
    const counter = this.counters.get(key);
    if (!counter || now - counter.start >= LIMIT_WINDOW_MS) { this.counters.set(key, { start: now, count: 1 }); return true; }
    counter.count += 1;
    return counter.count <= max;
  }

  revokeToken(token: string): void { this.tokens.delete(token); }

  private grant(account: string, provider: SignInProvider, family?: string, device = false) {
    if (family === undefined) {
      family = randomHex(16);
      this.signedInAt.set(family, this.now());
      this.twoStep.set(family, this.signInTwoStep);
      if (device) this.deviceFamilies.add(family);
    }
    const access = randomHex(32);
    const refresh = randomHex(32);
    this.tokens.set(access, { account, provider, family, expires: this.now() + ACCESS_TOKEN_TTL_S * 1000 });
    this.refreshTokens.set(refresh, { account, provider, family, used: false });
    return json({ access_token: access, refresh_token: refresh, expires_in: ACCESS_TOKEN_TTL_S, account, provider });
  }

  private signIn(url: URL, provider: string): Response {
    if (!SIGN_IN_PROVIDERS.includes(provider)) return problem(404, "not_found", "Unknown provider");
    const redirect = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    if (!isAllowedRedirect(redirect)) return problem(400, "invalid_redirect_uri", "That redirect is not allowed");
    // the web redirect always takes the fragment; the app's scheme may ask for it; a loopback server never sees one
    const mode = url.searchParams.get("response_mode") ?? (redirect === WEB_REDIRECT ? "fragment" : "query");
    const loopback = redirect.startsWith("http://127.0.0.1:");
    if ((mode !== "fragment" && mode !== "query") || (redirect === WEB_REDIRECT && mode !== "fragment") || (loopback && mode !== "query")) {
      return problem(400, "invalid_request", "That response_mode does not go with that redirect");
    }
    if (url.searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || state.length === 0) {
      return problem(400, "invalid_request", "Send state and an S256 code_challenge");
    }
    // a link token is spent here, but nothing is linked until its code is redeemed (token)
    const link = url.searchParams.get("link_token");
    const linking = link === null ? undefined : this.linkTokens.get(link);
    if (link !== null) this.linkTokens.delete(link);
    const valid = link === null || (linking !== undefined && linking.provider === provider && this.now() < linking.expires);
    const code = randomHex(32);
    if (valid) this.codes.set(code, { account: this.signIns.get(provider as SignInProvider) ?? `acct_${provider}`, provider: provider as SignInProvider, challenge, redirect, expires: this.now() + SIGNIN_CODE_TTL_MS, link: linking ? { account: linking.account, family: linking.family } : null });
    const back = new URL(redirect);
    const answer = new URLSearchParams(valid ? { code, state } : { error: "invalid_link", state });
    if (mode === "fragment") back.hash = answer.toString();
    else back.search = answer.toString();
    return new Response(null, { status: 302, headers: { location: back.href } });
  }

  private async token(request: Request): Promise<Response> {
    const body = await request.json() as Record<string, unknown>;
    const invalid = (message: string) => problem(400, "invalid_grant", message);
    switch (body.grant_type) {
      case "authorization_code": {
        const code = typeof body.code === "string" ? this.codes.get(body.code) : undefined;
        if (typeof body.code === "string") this.codes.delete(body.code);
        if (!code || this.now() >= code.expires || body.redirect_uri !== code.redirect) return invalid("The code is wrong, spent or expired");
        if (typeof body.code_verifier !== "string" || !PKCE.test(body.code_verifier) || await s256(body.code_verifier) !== code.challenge) return invalid("The code_verifier does not match");
        if (code.link === null) {
          this.addIdentity(code.account, code.provider);
          return this.grant(code.account, code.provider);
        }
        // a link commits only here, redeemed by the very sign-in that asked for it
        const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
        const holder = bearer === undefined ? undefined : this.tokens.get(bearer);
        if (holder === undefined || holder.family !== code.link.family || this.now() >= holder.expires || this.revokedFamilies.has(holder.family)) return invalid("Redeem a link with the sign-in that asked for it");
        if (code.account !== code.link.account && this.identityList.get(code.account)?.has(code.provider)) return problem(409, "identity_in_use", "That identity belongs to another account");
        this.signIns.set(code.provider, code.link.account);
        this.addIdentity(code.link.account, code.provider);
        return this.grant(code.link.account, code.provider);
      }
      case "refresh_token": {
        const refresh = typeof body.refresh_token === "string" ? this.refreshTokens.get(body.refresh_token) : undefined;
        if (!refresh || this.revokedFamilies.has(refresh.family)) return invalid("Sign in again");
        // a refresh token is good once: seeing it again means it leaked, so the whole family goes
        if (refresh.used) { this.revokeFamily(refresh.family); return invalid("Sign in again"); }
        refresh.used = true;
        return this.grant(refresh.account, refresh.provider, refresh.family);
      }
      case "apple_id_token": {
        const apple = typeof body.id_token === "string" ? this.appleTokens.get(body.id_token) : undefined;
        if (typeof body.id_token === "string") this.appleTokens.delete(body.id_token);
        // the app sends its plain nonce; Apple was given its SHA-256 in lowercase hex
        if (!apple || typeof body.nonce !== "string" || body.nonce.length < 16 || body.nonce.length > 128 || await sha256Hex(body.nonce) !== apple.nonce) return invalid("The identity token is not valid for that nonce");
        return this.grant(apple.account, "apple");
      }
      case "urn:ietf:params:oauth:grant-type:device_code": {
        const entry = typeof body.device_code === "string" ? this.deviceSignIns.get(body.device_code) : undefined;
        if (!entry || this.now() >= entry.expires) return problem(400, "expired_token", "Start the sign-in again");
        // a bound sign-in: refused before anything else, so a poll without the verifier moves nothing
        if (entry.challenge !== null && (typeof body.code_verifier !== "string" || !PKCE.test(body.code_verifier) || await s256(body.code_verifier) !== entry.challenge)) {
          return invalid("That verifier is not this sign-in's");
        }
        if (this.now() < entry.nextPoll) {
          entry.interval += DEVICE_POLL_S;
          entry.nextPoll = this.now() + entry.interval * 1000;
          return problem(400, "slow_down", `Poll every ${entry.interval} seconds`);
        }
        entry.nextPoll = this.now() + entry.interval * 1000;
        if (entry.denied) { this.deviceSignIns.delete(body.device_code as string); return problem(400, "access_denied", "The sign-in was refused at the provider"); }
        if (entry.account === null) return problem(400, "authorization_pending", "Waiting for the sign-in at the provider");
        this.deviceSignIns.delete(body.device_code as string);
        this.addIdentity(entry.account, entry.provider);
        return this.grant(entry.account, entry.provider, undefined, true);
      }
      default: return problem(400, "unsupported_grant_type", "Use authorization_code, refresh_token or apple_id_token");
    }
  }

  /** POST /v1/signout/all: every sign-in of the account ends, codes not yet redeemed included; its PCs and device keys stay. */
  private signOutEverywhere(account: string): void {
    for (const held of [...this.tokens.values()]) if (held.account === account) this.revokeFamily(held.family);
    for (const [token, refresh] of this.refreshTokens) if (refresh.account === account) { this.revokedFamilies.add(refresh.family); this.refreshTokens.delete(token); }
    for (const [family, push] of this.pushes) if (push.account === account) this.pushes.delete(family);
    for (const [token, link] of this.linkTokens) if (link.account === account) this.linkTokens.delete(token);
    for (const [code, held] of this.codes) if (held.account === account) this.codes.delete(code);
    for (const [code, waiting] of this.deviceSignIns) if (waiting.account === account) this.deviceSignIns.delete(code);
  }

  private erase(account: string): void {
    this.signOutEverywhere(account);
    for (const [provider, signsInTo] of this.signIns) if (signsInTo === account) this.signIns.delete(provider);
    for (const key of [...this.mailboxes.keys()]) if (key.endsWith(`\0${account}`)) this.mailboxes.delete(key);
    for (const key of [...this.pcLeaves.keys()]) if (key.endsWith(`\0${account}`)) this.pcLeaves.delete(key);
    for (const key of [...this.counters.keys()]) if (key.endsWith(`:${account}`)) this.counters.delete(key);
    for (const list of [this.admissionList, this.quietList]) for (let index = list.length - 1; index >= 0; index--) if (list[index]?.account === account) list.splice(index, 1);
    this.identityList.delete(account);
    // the account's deletion is the only thing that deletes its list
    const list = this.accountLists.get(account);
    if (list !== undefined) this.lists.delete(list);
    this.accountLists.delete(account);
    this.directories.delete(account);
    this.accountLimits.delete(account);
    this.deletedAccounts.add(account);
  }

  private revokeFamily(family: string): void {
    this.revokedFamilies.add(family);
    for (const [token, session] of this.tokens) if (session.family === family) this.tokens.delete(token);
  }

  private registry(account: string): Registry {
    const registry = this.registries.get(account) ?? { next: 1, version: 1, methods_version: 0, devices: new Map(), blocks: [], lifts: [], freezes: [] };
    this.registries.set(account, registry);
    return registry;
  }

  /** Device table P18, P21: registers a key for the account (S2-19 adds the route) and returns its `no`. */
  /** The account device key the sign-in behind `token` registers now, as POST /v1/devices would. */
  registerSessionKey(token: string, key: string, label: string): number {
    const session = this.tokens.get(token);
    if (session === undefined) throw new Error("no such token");
    this.keyRegisteredAt.set(session.family, this.now());
    this.keyFamily.set(key, session.family);
    return this.registerDevice(session.account, key, label);
  }

  /**
   * Whether the account was ever used, as the service's first-PC exemption judges it (account#62, NEVER_USED_ADMIT and
   * NEVER_USED_CONFIRM): another PC listed but a device code's listing made under Step 2 that nobody confirmed or admitted
   * (PCL-1: anyone may type a code), a one-press admit or a member's removal ever; then device keys, revoked ones
   * included, but one this sign-in registered itself. For the admit (`kind` "admit") they count only once the account
   * had a confirmed or admitted PC, since a person may sign in on the phone first; for a confirm, always.
   */
  /**
   * Whether a listing is a member of its account, as the service's memberPc (NO_PC_YET's basis): a PC of the account where
   * Step 2 is on now, or one never pending under Step 2. A device code's listing made while Step 2 was off stays one.
   */
  private member(row: FakePc): boolean {
    return !this.opensAll || row.listed_by_device !== true || row.pending_under_step2 !== true;
  }

  private everUsed(account: string, serverId: string, family: string, kind: "admit" | "confirm"): boolean {
    const rows = [...(this.directories.get(account)?.values() ?? [])];
    const pending = (row: FakePc): boolean => row.pending_under_step2 === true && row.listed_by_device === true && row.admitted_at == null;
    if (rows.some((row) => row.server_id !== serverId && !pending(row)) || this.usedAccounts.has(account)) return true;
    const keys = [...(this.registries.get(account)?.devices.keys() ?? [])].filter((key) => this.keyFamily.get(key) !== family);
    if (keys.length === 0) return false;
    if (kind === "confirm") return true;
    return rows.some((row) => row.admitted_at != null || (row.server_id !== serverId && row.listed_by_device !== true));
  }

  registerDevice(account: string, key: string, label: string, eligible = true): number {
    const registry = this.registry(account);
    const known = registry.devices.get(key);
    if (known) return known.no;
    const no = registry.next++;
    registry.devices.set(key, { no, label, eligible, removed: false });
    registry.version += 1;
    return no;
  }

  /** Device table T36 (service effect): the key leaves the list and keeps its `no` in `removed`. */
  removeDevice(account: string, key: string): void {
    const device = this.registry(account).devices.get(key);
    if (!device || device.removed) return;
    device.removed = true;
    this.registry(account).version += 1;
  }

  private methodsChanged(account: string): void {
    const registry = this.registry(account);
    registry.methods_version += 1;
    registry.version += 1;
  }

  /** Makes every snapshot id handed out so far answer `snapshot_gone`. */
  dropSnapshots(): void { this.snapshots.clear(); }

  pcs(account: string): FakePc[] { return [...this.directories.get(account)?.values() ?? []]; }

  admissions(): readonly FakeAdmission[] { return this.admissionList; }

  quietAdmissions(): readonly FakeAdmission[] { return this.quietList; }

  mailbox(serverId: string, account: string): AccountRecord[] {
    this.expire();
    return (this.mailboxes.get(box(serverId, account)) ?? []).map(({ record }) => record);
  }

  dropQueuedRecords(serverId: string, account: string, predicate: (record: AccountRecord) => boolean): void {
    const key = box(serverId, account);
    this.mailboxes.set(key, (this.mailboxes.get(key) ?? []).filter(({ record }) => !predicate(record)));
  }

  readonly fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    this.requests.push(`${request.method} ${url.pathname}`);
    try {
      if (url.pathname.startsWith("/v2/")) return await this.v2(request, url);
      if (url.pathname.startsWith("/v1/pc/")) return await this.pc(request, url.pathname);
      const leaving = /^\/v1\/pcs\/([0-9a-f]{32})\/leave$/.exec(url.pathname)?.[1];
      if (leaving !== undefined && request.method === "POST") return await this.leave(request, leaving);
      const provider = /^\/v1\/signin\/([a-z]+)$/.exec(url.pathname)?.[1];
      if (provider !== undefined && request.method === "GET") return this.signIn(url, provider);
      if (url.pathname === "/v1/token" && request.method === "POST") return await this.token(request);
      if (url.pathname === "/v1/providers" && request.method === "GET") return json(this.offered);
      if (url.pathname === "/v1/signin/ovis/device" && request.method === "POST" && (this.offered.device_page ?? []).length > 0) {
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        const label = body.label;
        if (body.code_challenge_method !== "S256" || typeof body.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge)
          || (label !== undefined && (typeof label !== "string" || label.length < 1 || label.length > 48 || /[\p{Cc}\p{Cs}]/u.test(label)))
          || Object.keys(body).some((name) => !["code_challenge", "code_challenge_method", ...(this.linkPageAcceptsLabelAndOs ? ["label", "os"] : [])].includes(name))) {
          return problem(400, "invalid_request", "Start a sign-in on the link page with an S256 code_challenge, and a label of 1-48 characters if any");
        }
        const deviceCode = randomHex(32);
        const letters = "BCDFGHJKLMNPQRSTVWXZ";
        const pick = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => letters[byte % letters.length]).join("");
        const userCode = `${pick()}-${pick()}`;
        this.deviceSignIns.set(deviceCode, { provider: "github", userCode, account: null, denied: false, interval: DEVICE_POLL_S, nextPoll: this.now(), expires: this.now() + 600_000, challenge: body.code_challenge, page: true, requester: { label: typeof label === "string" ? label : null, os: accountOsOf(body.os) } });
        const page = new URL("/link", url.origin);
        const complete = new URL(page);
        complete.searchParams.set("code", userCode);
        return json({ device_code: deviceCode, user_code: userCode, verification_uri: page.href, verification_uri_complete: complete.href, expires_in: 600, interval: DEVICE_POLL_S, code_challenge_method: "S256" });
      }
      const deviceProvider = /^\/v1\/signin\/([a-z]+)\/device$/.exec(url.pathname)?.[1];
      if (deviceProvider !== undefined && DEVICE_PAGES[deviceProvider] !== undefined && request.method === "POST") {
        const text = await request.text();
        const body = (text.trim() === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
        // a device code can be phished (RFC 8628): it signs in, but never adds a method to an account
        if ("link_token" in body) return problem(400, "invalid_request", "Add a sign-in method through a redirect sign-in");
        const bound = Object.keys(body).length > 0;
        if (bound && (body.code_challenge_method !== "S256" || typeof body.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge) || Object.keys(body).length !== 2)) {
          return problem(400, "invalid_request", "Start a device sign-in with nothing, or an S256 code_challenge");
        }
        const deviceCode = randomHex(32);
        const userCode = `${randomHex(2).toUpperCase()}-${randomHex(2).toUpperCase()}`;
        this.deviceSignIns.set(deviceCode, { provider: deviceProvider as SignInProvider, userCode, account: null, denied: false, interval: DEVICE_POLL_S, nextPoll: this.now(), expires: this.now() + DEVICE_CODE_TTL_S * 1000, challenge: bound ? body.code_challenge as string : null });
        return json({ device_code: deviceCode, user_code: userCode, verification_uri: DEVICE_PAGES[deviceProvider], expires_in: DEVICE_CODE_TTL_S, interval: DEVICE_POLL_S, ...(bound ? { code_challenge_method: "S256" } : {}) });
      }
      if (url.pathname === "/v1/push/key" && request.method === "GET") return json({ public_key: "BFakeVapidPublicKeyForTests" });
      return await this.client(request, url.pathname);
    } catch (error) {
      if (error instanceof AccountRecordError) return problem(400, "record_invalid", error.message);
      if (error instanceof SyntaxError) return problem(400, "invalid_json", "The body is not JSON");
      throw error;
    }
  };

  private async client(request: Request, path: string): Promise<Response> {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const session = bearer === undefined ? undefined : this.tokens.get(bearer);
    if (session === undefined || this.now() >= session.expires || this.revokedFamilies.has(session.family)) return problem(401, "unauthorized", "Sign in again");
    const account = session.account;
    if (!this.withinRateLimit(`requests:${account}`, ACCOUNT_REQUESTS_PER_WINDOW)) return problem(429, "rate_limited", "Too many requests; try again later");
    if (path === "/v1/signout" && request.method === "POST") {
      this.revokeFamily(session.family);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/push" && request.method === "PUT") {
      const body = await request.json() as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
      if (typeof body.endpoint !== "string" || !URL.canParse(body.endpoint) || typeof body.keys?.p256dh !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(body.keys.p256dh)
        || typeof body.keys.auth !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(body.keys.auth)) return problem(400, "invalid_endpoint", "Send the subscription's endpoint and keys");
      this.pushes.set(session.family, { account, endpoint: body.endpoint });
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/push" && request.method === "DELETE") {
      this.pushes.delete(session.family);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/identities" && request.method === "GET") {
      return json({ identities: [...this.identityList.get(account) ?? []].map(([provider, { added_at }]) => ({ provider, added_at })) });
    }
    if (path === "/v1/account/limits" && request.method === "GET") {
      const limits = this.accountLimits.get(account);
      return limits ? json(limits) : problem(404, "not_found", "Unknown request");
    }
    const recent = this.now() - (this.signedInAt.get(session.family) ?? Number.NEGATIVE_INFINITY) <= REAUTH_MS;
    if ((path === "/v1/identities/link" && request.method === "POST") || (path.startsWith("/v1/identities/") && request.method === "DELETE")) {
      if (!recent) return problem(403, "reauth_required", "Sign in again first");
    }
    if (path === "/v1/signout/all" && request.method === "POST") {
      // as deleting the account: a device code's sign-in never signs the account's owner out, and only a recent one does
      if (this.deviceFamilies.has(session.family)) return problem(403, "web_sign_in_required", "Sign in on this device first");
      if (!recent) return problem(403, "reauth_required", "Sign in again first");
      this.ring(account, session.family);
      this.signOutEverywhere(account);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/account" && request.method === "DELETE") {
      // a device code can be typed for someone else's PC: its sign-in must not end the account
      if (this.deviceFamilies.has(session.family)) return problem(403, "web_sign_in_required", "Sign in on this device first");
      if (!recent) return problem(403, "reauth_required", "Sign in again first");
      if (this.subscribed.has(account)) return problem(409, "subscription_active", "Cancel the subscription in the billing portal first");
      this.erase(account);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/identities/link" && request.method === "POST") {
      const body = await request.json() as { provider?: unknown };
      if (typeof body.provider !== "string" || !this.offered.providers.includes(body.provider as SignInProvider)) return problem(400, "invalid_provider", "Name a provider this service offers");
      if (this.identityList.get(account)?.has(body.provider as SignInProvider)) return problem(409, "identity_exists", "The account already signs in with it");
      const token = randomHex(32);
      this.linkTokens.set(token, { account, family: session.family, provider: body.provider as SignInProvider, expires: this.now() + LINK_TOKEN_TTL_S * 1000 });
      return json({ link_token: token, expires_in: LINK_TOKEN_TTL_S });
    }
    const removed = /^\/v1\/identities\/([a-z]+)$/.exec(path)?.[1] as SignInProvider | undefined;
    if (removed !== undefined && request.method === "DELETE") {
      const methods = this.identityList.get(account);
      if (!methods?.has(removed)) return problem(404, "not_found", "The account does not sign in with it");
      if (methods.size === 1) return problem(409, "last_identity", "Add another way to sign in first");
      methods.delete(removed);
      this.methodsChanged(account);
      if (this.signIns.get(removed) === account) this.signIns.delete(removed);
      // the sign-ins made with it end
      for (const held of [...this.tokens.values()]) if (held.account === account && held.provider === removed) this.revokeFamily(held.family);
      return new Response(null, { status: 204 });
    }
    const directory = this.directories.get(account) ?? new Map<string, FakePc>();
    this.directories.set(account, directory);
    if (path === "/v1/session" && request.method === "GET") {
      return json({ account, own_sign_in: !this.deviceFamilies.has(session.family), signed_in_at: new Date(this.signedInAt.get(session.family) ?? this.now()).toISOString() });
    }
    if (path === "/v1/pcs" && request.method === "GET") {
      // PCL-1: while step 2 is on, a PC listed by a device code and not confirmed only for `?include=unconfirmed`
      const unconfirmed = new URL(request.url).searchParams.get("include") === "unconfirmed";
      // null while step 2 is off for the account, and once passed
      const keyAt = this.keyRegisteredAt.get(session.family);
      return json({ pcs: [...directory.values()].filter((entry) => unconfirmed || !this.opensAll || entry.listed_by_device !== true).map(({ exempt, listed_by_device, pending_under_step2: _pending, listed_by_session: _lister, digit_admitted: _digits, ...entry }) => ({
        ...entry,
        unconfirmed: this.opensAll && listed_by_device === true,
        new_until: this.opensAll && entry.new_until != null && Date.parse(entry.new_until) > this.now() ? entry.new_until : null,
        admitted_at: this.opensAll ? entry.admitted_at ?? null : null,
        // the one admit no device was told about: shown to a device whose own key came after it
        admitted_before_you: this.opensAll && exempt === true && keyAt !== undefined && entry.admitted_at != null && Date.parse(entry.admitted_at) < keyAt,
      })) });
    }
    if (path === "/v1/pcs/challenge" && request.method === "POST" && this.opensAll) {
      // a challenge for one key proof (keyProofBytes), for an app's own sign-in only, spent by its first use. The list
      // routes take it for `list-genesis` and `list-claim`
      if (this.deviceFamilies.has(session.family)) return problem(403, "own_sign_in_required", "Sign in on this device first");
      const text = await request.text();
      const body: unknown = text.trim() === "" ? {} : JSON.parse(text);
      if (typeof body !== "object" || body === null || Object.keys(body).length > 0) return problem(400, "invalid_request", "Send {}");
      const id = randomHex(16);
      const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      this.pcAddChallenges.set(id, { family: session.family, challenge, expires: this.now() + PC_ADD_CHALLENGE_TTL_MS });
      return json({ challenge_id: id, challenge, expires_in: PC_ADD_CHALLENGE_TTL_MS / 1000 });
    }
    const admitted = /^\/v1\/pcs\/([0-9a-f]{32})\/admit$/.exec(path)?.[1];
    if (admitted !== undefined && request.method === "POST" && this.opensAll) {
      // C1: an app's own sign-in, made within REAUTH_MS, with two-step sign-in set (unknown is not enough)
      if (this.deviceFamilies.has(session.family)) return problem(403, "own_sign_in_required", "Sign in in the app itself");
      if (this.now() - (this.signedInAt.get(session.family) ?? Number.NEGATIVE_INFINITY) > REAUTH_MS) return problem(403, "session_not_fresh", "Sign in again on this device first");
      // the first-PC exemption: an account never used (no other PC, no admit or removal, no device key ever) waives two-step
      const exempt = this.twoStep.get(session.family) !== true;
      const entry = directory.get(admitted);
      const open = this.pcAdmissions.get(box(admitted, account));
      // a retry of this same sign-in's own admission, still open, gets the same answer: no second exemption is granted
      const retry = entry !== undefined && open !== undefined && !open.taken && open.family === session.family && this.now() - open.at <= ADMISSION_TTL_MS && entry.new_until != null;
      if (this.admitAsksTwoStep && exempt && !retry && this.everUsed(account, admitted, session.family, "admit")) return problem(403, "two_step_required", "Set up two-step sign-in first");
      if (entry === undefined) return problem(400, "unknown_pc", "List PCs of this account only");
      if (open !== undefined && !open.taken && this.now() - open.at <= ADMISSION_TTL_MS && entry.new_until != null) {
        return json({ server_id: admitted, account, admitted_at: new Date(open.at).toISOString(), new_until: entry.new_until });
      }
      // C4: the account's one-press adds of the last day
      const times = (this.admitTimes.get(account) ?? []).filter((at) => this.now() - at < PC_NEW_MS);
      if (times.length >= PC_ADMITS_PER_DAY) {
        const capped = problem(429, "pc_add_cap", "This account added enough PCs today");
        capped.headers.set("retry-after", String(Math.ceil((times[0]! + PC_NEW_MS - this.now()) / 1000)));
        return capped;
      }
      this.admitTimes.set(account, [...times, this.now()]);
      // one instant for the admission, its directory entry and this answer: a retry answers the same
      const at = this.now();
      this.pcAdmissions.set(box(admitted, account), { at, taken: false, family: session.family, ...(entry.listing_id === undefined ? {} : { listing: entry.listing_id }) });
      this.usedAccounts.add(account);
      entry.new_until = new Date(this.now() + PC_NEW_MS).toISOString();
      entry.admitted_at = new Date(at).toISOString();
      entry.exempt = exempt;
      entry.listed_by_device = false;
      this.ring(account, session.family);
      return json({ server_id: admitted, account, admitted_at: new Date(at).toISOString(), new_until: entry.new_until });
    }
    const pc = /^\/v1\/pcs\/([0-9a-f]{32})$/.exec(path)?.[1];
    if (pc !== undefined && request.method === "PUT") {
      const body = await request.json() as { label?: unknown; public_key?: unknown; relay?: unknown; confirm?: unknown; listing_id?: unknown; challenge_id?: unknown; proof?: unknown };
      // PCL-1: only an app's own sign-in may say "this is my PC"; a device code can be typed for someone else's PC
      const own = !this.deviceFamilies.has(session.family);
      const confirm = body.confirm === true;
      // account#67: a confirm names the listing its card showed, and only a confirm does
      const named = body.listing_id !== undefined;
      if (named && (!confirm || typeof body.listing_id !== "string" || !LISTING_ID.test(body.listing_id))) return problem(400, "invalid_request", "Name a listing only to confirm it");
      if (confirm && !own) return problem(403, "own_sign_in_required", "Sign in on this device to confirm the PC");
      if (typeof body.label !== "string" || body.label.length < 1 || body.label.length > 48) return problem(400, "invalid_label", "Name the PC");
      // the key is stored, but it cannot be forged: it must give this server_id
      const key = proofKey(body.public_key);
      if (!key || deriveServerId(key) !== pc) return problem(400, "server_key_mismatch", "That key does not give that server_id");
      if (typeof body.relay !== "string" || !isWssOrigin(body.relay)) return problem(400, "invalid_relay", "Give the relay's wss origin");
      // the PC's own proof of this server_id, sent beside the entry when the PC itself lists it: it lists it again after its leave
      const proven = body.challenge_id !== undefined || body.proof !== undefined;
      if (proven && !this.takeProof({ server_id: pc, challenge_id: body.challenge_id, proof: body.proof })) return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
      // PCL-4: a confirm asks what the one-press admit asks of the sign-in: fresh, and two-step set unless the account was never used
      if (confirm) {
        if (this.now() - (this.signedInAt.get(session.family) ?? Number.NEGATIVE_INFINITY) > REAUTH_MS) return problem(403, "session_not_fresh", "Sign in again on this device first");
        if (this.twoStep.get(session.family) !== true && this.everUsed(account, pc, session.family, "confirm")) return problem(403, "two_step_required", "Two-step sign-in must be on for one press; add this PC with the number");
      }
      const fresh = !directory.has(pc);
      const leftAt = this.pcLeaves.get(box(pc, account));
      if (fresh && !proven && leftAt !== undefined && this.now() - leftAt < PC_LEFT_MS) {
        return json({ error: { left_at: new Date(leftAt).toISOString(), code: "pc_left", message: "This PC left the account; sign in on the PC to add it again" } }, 409);
      }
      if (fresh && directory.size >= DIRECTORY_MAX) return problem(409, "directory_full", "Remove a PC first");
      // a re-PUT (the nine-minute relist) keeps the PC's admission and its confirmation mark
      const before = directory.get(pc);
      // a named confirm acts only on that listing, still the PC's current one and still unconfirmed, and writes the confirm alone
      if (named && (before === undefined || before.listing_id !== body.listing_id || before.listed_by_device !== true)) {
        return problem(409, "listing_changed", "This add is no longer waiting for that action");
      }
      const confirming = confirm && before?.listed_by_device === true;
      const entry: FakePc = { server_id: pc, ...(named ? { label: before!.label, public_key: before!.public_key, relay: before!.relay } : { label: body.label, public_key: body.public_key as string, relay: body.relay }), added_at: before?.added_at ?? this.iso(), last_seen_at: before?.last_seen_at ?? null,
        ...(before?.new_until == null ? {} : { new_until: before.new_until, admitted_at: before.admitted_at ?? null, exempt: before.exempt ?? false }),
        listed_by_device: before === undefined ? !own : before.listed_by_device === true && !confirming,
        pending_under_step2: before === undefined ? !own && this.opensAll : before.pending_under_step2 === true,
        ...(before === undefined ? { listed_by_session: session.family } : before.listed_by_session === undefined ? {} : { listed_by_session: before.listed_by_session }),
        ...(this.completions ? { listing_id: before?.listing_id ?? randomHex(16), completed_at: before?.completed_at ?? null } : {}) };
      // a confirm makes the PC one the account's devices open, as the admit does: new to them for PC_NEW_MS (C3). It
      // writes no admission: the row it confirms is what makes the account used from then on
      if (confirming) {
        entry.admitted_at = this.iso();
        entry.new_until = new Date(this.now() + PC_NEW_MS).toISOString();
      }
      directory.set(pc, entry);
      if (proven) this.pcLeaves.delete(box(pc, account));
      if (fresh || confirming) this.ring(account, session.family);
      const { exempt: _exempt, listed_by_device, pending_under_step2: _pending, listed_by_session: _lister, digit_admitted: _digits, ...shown } = entry;
      return json({ pc: { ...shown, unconfirmed: this.opensAll && listed_by_device === true } });
    }
    if (pc !== undefined && request.method === "DELETE") {
      // account#67: a Decline names the listing its card showed; after the sign-in checks, it removes only that listing while
      // it still asks to join (not admitted by one press, a confirm or digits, and not completed)
      const named = new URL(request.url).searchParams.get("listing_id");
      if (named !== null && !LISTING_ID.test(named)) return problem(400, "invalid_request", "That is no listing ID");
      const listed = directory.get(pc);
      const changed = named !== null && (listed === undefined || listed.listing_id !== named || listed.admitted_at != null || listed.digit_admitted === true || listed.completed_at != null);
      // PCR-1: removing unbinds the PC and cuts the account's devices off it, so it asks what deleting the account asks. The
      // compat ruling's one exception: a device code's sign-in ends its own listing (written by it, never confirmed, admitted
      // or completed), as an installed CLI renews its card
      if (this.deviceFamilies.has(session.family)) {
        const own = directory.get(pc);
        // as the service: written by this sign-in, never confirmed, admitted (one press or digits) or completed
        if (own === undefined || own.listed_by_session !== session.family || own.listed_by_device !== true || own.admitted_at != null
          || own.completed_at != null || own.digit_admitted === true) {
          return problem(403, "own_sign_in_required", "Sign in on this device to remove a PC");
        }
        if (changed) return problem(409, "listing_changed", "This PC no longer asks to join by that listing");
        directory.delete(pc);
        // ruling (b): a member's end is a member's removal (the account is used); a listing pending under Step 2 was never one
        if (this.member(own)) this.usedAccounts.add(account);
        return new Response(null, { status: 204 });
      }
      if (!recent) return problem(403, "reauth_required", "Sign in again first");
      if (changed) return problem(409, "listing_changed", "This PC no longer asks to join by that listing");
      const removed = directory.get(pc);
      directory.delete(pc);
      this.pcAdmissions.delete(box(pc, account));
      // PCL-1: ending a listing that was never the account's (unconfirmed under Step 2) is no member's removal
      if (removed !== undefined && this.member(removed)) this.usedAccounts.add(account);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/records" && request.method === "POST") {
      const body = await request.json() as { server_ids?: unknown; record?: unknown };
      if (!Array.isArray(body.server_ids) || body.server_ids.length > ACCOUNT_RECORDS_MAX || !body.server_ids.every((id) => typeof id === "string" && directory.has(id))) {
        return problem(400, "unknown_pc", "List PCs of this account only");
      }
      const record = await readAccountRecord(body.record);
      if (!record) return problem(400, "signature_invalid", "The signature does not hold");
      if (record.account !== account) return problem(403, "account_mismatch", "The record is for another account");
      const targets = [...new Set(body.server_ids as string[])];
      this.expire();
      if (targets.some((id) => (this.mailboxes.get(box(id, account))?.length ?? 0) >= MAILBOX_MAX)) return problem(429, "mailbox_full", "That PC has not collected its records");
      for (const id of targets) {
        const queue = this.mailboxes.get(box(id, account)) ?? [];
        queue.push({ seq: ++this.seq, record, at: this.now() });
        this.mailboxes.set(box(id, account), queue);
      }
      return json({ queued: new Set(body.server_ids).size });
    }
    if (path === "/v1/safety-records" && request.method === "POST" && this.opensAll) return await this.safetyRecord(account, await request.json());
    if (path === "/v1/admissions" && request.method === "GET") {
      // what the approving client checks the key PC X shows it against, before it signs an add
      const admissions = this.admissionList
        .filter((a) => a.account === account && this.now() - Date.parse(a.at) < ADMISSION_TTL_MS)
        .map(({ key, label, server_id, at, os, country, city }) => ({ key, label, server_id, at, os, country, city }));
      return json({ admissions });
    }
    if (path === "/v1/admissions" && request.method === "POST") {
      const body = await request.json() as { server_id?: unknown; label?: unknown; key?: unknown; os?: unknown; quiet?: unknown };
      if (body.quiet !== undefined && typeof body.quiet !== "boolean") return problem(400, "invalid_request", "quiet is true or false");
      if (typeof body.server_id !== "string" || !directory.has(body.server_id) || typeof body.label !== "string") return problem(400, "unknown_pc", "List PCs of this account only");
      if (!isAccountKeyEncoding(body.key)) return problem(400, "invalid_key", "Name the waiting device's account key");
      // quiet only for an app's own sign-in: one a typed device code opened gets the ordinary kind
      const quiet = body.quiet === true && !this.deviceFamilies.has(session.family);
      if (!this.withinRateLimit(quiet ? `quiet_admissions:${account}` : `admissions:${account}`, quiet ? QUIET_ADMISSIONS_PER_WINDOW : ADMISSIONS_PER_WINDOW)) return problem(429, "too_many_admissions", "Too many requests; try again later");
      const admission = { id: randomHex(16), server_id: body.server_id, account, label: body.label, key: body.key, at: this.iso(), os: accountOsOf(body.os), ...this.requestPlace };
      (quiet ? this.quietList : this.admissionList).push(admission);
      if (!quiet) this.ring(account, session.family);
      return json({ id: admission.id });
    }
    return problem(404, "not_found", "Unknown request");
  }

  /** Spends the challenge `body` names and says whether `body.proof` answers it for `body.server_id`. */
  private takeProof(body: { server_id: unknown; challenge_id: unknown; proof: unknown }): { server_id: string } | null {
    const challenge = typeof body.challenge_id === "string" ? this.challenges.get(body.challenge_id) : undefined;
    if (typeof body.challenge_id === "string") this.challenges.delete(body.challenge_id);
    if (!challenge || challenge.server_id !== body.server_id || this.now() > challenge.expires || !verifyServerProof(body.proof, challenge.expected)) return null;
    return { server_id: challenge.server_id };
  }

  /**
   * The PC leaves an account by its own proof, with no bearer (`ovis logout`, account#65): as a DELETE /v1/pcs does, the
   * listing and its untaken admission end; its mailbox and admissions for the account go; and for PC_LEFT_MS a PUT
   * lists it again only with the PC's own proof. 204 whether or not the account listed it.
   */
  private async leave(request: Request, serverId: string): Promise<Response> {
    const body = await request.json() as Record<string, unknown>;
    if (body.server_id !== serverId || typeof body.account !== "string" || body.challenge_id === undefined || body.proof === undefined) {
      return problem(400, "invalid_request", "Name this PC and the account it leaves");
    }
    if (!this.takeProof({ server_id: serverId, challenge_id: body.challenge_id, proof: body.proof })) return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
    const account = body.account;
    const key = box(serverId, account);
    const directory = this.directories.get(account);
    const removed = directory?.get(serverId);
    directory?.delete(serverId);
    this.pcAdmissions.delete(key);
    this.mailboxes.delete(key);
    for (const list of [this.admissionList, this.quietList]) {
      for (let index = list.length - 1; index >= 0; index--) if (list[index]!.server_id === serverId && list[index]!.account === account) list.splice(index, 1);
    }
    if (!this.deletedAccounts.has(account)) this.pcLeaves.set(key, this.now());
    if (removed !== undefined) {
      if (!(this.opensAll && removed.listed_by_device === true)) this.usedAccounts.add(account);
      this.ring(account, "");
    }
    return new Response(null, { status: 204 });
  }

  private async pc(request: Request, path: string): Promise<Response> {
    if (request.method !== "POST") return problem(404, "not_found", "Unknown request");
    const body = await request.json() as Record<string, unknown>;
    if (path === "/v1/pc/challenge") {
      const key = proofKey(body.public_key);
      if (!key || typeof body.server_id !== "string" || deriveServerId(key) !== body.server_id) return problem(401, "server_key_mismatch", "That key does not give that server_id");
      const challengeId = randomHex(16);
      // a completion's proof is scoped to its account and listing: its context is not a wire nonce (account#57)
      const scope = this.completions ? completionScope(body.completion) : null;
      if (body.completion !== undefined && scope === null) return problem(400, "invalid_body", "Name the account and listing");
      const context = scope ? completionKey(scope, challengeId) : challengeId;
      const { expected, frame } = serverChallenge(key, { server_id: body.server_id, role: "account", connection_id: context });
      this.challenges.set(context, { server_id: body.server_id, expected, expires: this.now() + CHALLENGE_TTL_MS });
      return json({ challenge_id: challengeId, frame });
    }
    if (path === "/v1/pc/complete" && this.completions) {
      const scope = completionScope({ account: body.account, listing_id: body.listing_id });
      const context = scope && typeof body.challenge_id === "string" ? completionKey(scope, body.challenge_id) : null;
      const challenge = context === null ? undefined : this.challenges.get(context);
      if (context !== null) this.challenges.delete(context);
      if (!scope || !challenge || challenge.server_id !== body.server_id || this.now() > challenge.expires || !verifyServerProof(body.proof, challenge.expected)) {
        return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
      }
      const entry = this.directories.get(scope.account)?.get(challenge.server_id);
      // the listing still current, and its own evidence: an admission of it taken (or a completion already stamped)
      const taken = this.pcAdmissions.get(box(challenge.server_id, scope.account))?.taken === true;
      if (entry?.listing_id !== scope.listing_id || (entry.completed_at == null && !taken)) return problem(409, "listing_changed", "This add is no longer waiting for that action");
      entry.completed_at ??= this.iso();
      return json({ completed_at: entry.completed_at });
    }
    if (path === "/v1/pc/mailbox" || (path === "/v1/pc/admission" && this.opensAll)
      || (path === "/v1/pc/snapshot" && (this.opensAll || this.reportsStep2Off))) {
      const challenge = this.takeProof({ server_id: body.server_id, challenge_id: body.challenge_id, proof: body.proof });
      if (!challenge) return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
      if (typeof body.account !== "string") return problem(400, "invalid_account", "Name the account this PC belongs to");
      if (path === "/v1/pc/admission") {
        // G1: only the named account's own admission, while that account lists the PC; any other account's is invisible
        const open = this.pcAdmissions.get(box(challenge.server_id, body.account));
        const entry = this.directories.get(body.account)?.get(challenge.server_id);
        // retry-safe for 10 minutes, inclusive; it ends with the sign-in that made it
        if (open === undefined || this.now() - open.at > ADMISSION_TTL_MS || this.revokedFamilies.has(open.family) || entry?.new_until == null) return problem(404, "no_admission", "No account added this PC in one press");
        open.taken = true;
        return json({ account: body.account, admitted_at: new Date(open.at).toISOString(), new_until: entry.new_until,
          ...(this.completions && body.with_listing_id === true ? { listing_id: entry.listing_id ?? null } : {}) });
      }
      if (path === "/v1/pc/snapshot") {
        // P6: only a PC the account lists reads the account's devices and records
        if (!this.opensAll) return this.directories.get(body.account)?.has(challenge.server_id) === true
          ? problem(404, "step2_off", "Step 2 is off for this account")
          : problem(404, "not_found", "Unknown request");
        if (this.directories.get(body.account)?.has(challenge.server_id) !== true) return problem(403, "not_listed", "This PC is not one of the account's");
        return this.snapshotPage(challenge.server_id, body.account, body.snapshot, body.page);
      }
      this.expire();
      const key = box(challenge.server_id, body.account);
      const queue = this.mailboxes.get(key) ?? [];
      const ack = typeof body.ack === "number" ? body.ack : null;
      const rest = ack === null ? queue : queue.filter(({ seq }) => seq > ack);
      this.mailboxes.set(key, rest);
      // only the account the PC says it belongs to learns that it came by
      const entry = this.directories.get(body.account)?.get(challenge.server_id);
      if (entry) entry.last_seen_at = this.iso();
      const admissions = this.admissionList
        .filter((a) => a.server_id === challenge.server_id && a.account === body.account && this.now() - Date.parse(a.at) < ADMISSION_TTL_MS)
        .map(({ key, label, at }) => ({ key, label, at }));
      // the quiet ones in a field of their own, and only while the account still lists the PC
      const quiet = entry === undefined ? [] : this.quietList
        .filter((a) => a.server_id === challenge.server_id && a.account === body.account && this.now() - Date.parse(a.at) < ADMISSION_TTL_MS)
        .map(({ key, label, at }) => ({ key, label, at }));
      // as the service: the listing it holds this PC under, when it confirms one (never one a device code listed under Step 2)
      const named = entry !== undefined && !(this.opensAll && entry.listed_by_device === true) ? entry.listing_id ?? null : null;
      const taken = this.pcAdmissions.get(key);
      const listing = this.completions && body.with_listing_id === true
        ? { listing_id: named, ...(this.saysListingAdmitted ? { listing_admitted: named !== null && entry?.admitted_at != null && taken?.taken === true && taken.listing === named } : {}) } : {};
      // the signed list's id and head, read with the pull, for a PC the account lists confirmed; without the member, unchanged
      const list = body.with_list === true ? { list: this.mailboxList(challenge.server_id, body.account, entry) } : {};
      return json({ ...listing, ...list, records: rest.slice(0, MAILBOX_PAGE).map(({ seq, record }) => ({ seq, record })), more: rest.length > MAILBOX_PAGE, admissions, quiet_admissions: quiet });
    }
    return problem(404, "not_found", "Unknown request");
  }

  /**
   * Device table P6, G1: page 0 freezes the account's state under a new snapshot id; every later page is
   * asked by that id and served from the same state, or answered `snapshot_gone`.
   */
  private snapshotPage(serverId: string, account: string, id: unknown, page: unknown): Response {
    let state: SnapshotState | undefined;
    if (id === undefined && (page === undefined || page === 0)) {
      const registry = this.registry(account);
      const entries = [...registry.devices].sort(([, a], [, b]) => a.no - b.no);
      state = {
        snapshot: randomHex(16), account, server_id: serverId, version: registry.version, methods_version: registry.methods_version,
        // P16, G12: a key above a standing freeze line is not list-eligible
        devices: entries.filter(([, d]) => !d.removed).map(([key, { no, eligible, label }]) => ({ key, no, eligible: eligible && !this.frozen(registry, no), label })),
        removed: entries.filter(([, d]) => d.removed).map(([key, { no }]) => ({ key, no })),
        blocks: [...registry.blocks], lifts: [...registry.lifts], freezes: [...registry.freezes],
      };
      this.snapshots.set(state.snapshot, state);
    } else if (typeof id === "string") {
      state = this.snapshots.get(id);
      if (state === undefined || state.account !== account || state.server_id !== serverId) return problem(410, SNAPSHOT_GONE, "Start the read again");
    }
    if (state === undefined || !Number.isSafeInteger(page ?? 0) || (page ?? 0) as number < 0) return problem(400, "invalid_request", "Ask page 0 with no snapshot, then each page by its snapshot id");
    const index = (page ?? 0) as number;
    // every list is paged on its own, so no page holds more than SNAPSHOT_PAGE entries of any list
    const lists = [state.devices, state.removed, state.blocks, state.lifts, state.freezes];
    const pages = Math.max(1, ...lists.map((list) => Math.ceil(list.length / SNAPSHOT_PAGE)));
    if (index >= pages) return problem(400, "invalid_request", "No such page");
    const slice = <T>(list: readonly T[]) => list.slice(index * SNAPSHOT_PAGE, (index + 1) * SNAPSHOT_PAGE);
    const body: AccountSnapshotPage = {
      v: ACCOUNT_SNAPSHOT_V, snapshot: state.snapshot, account, server_id: serverId, version: state.version, methods_version: state.methods_version, page: index, last: index === pages - 1,
      devices: slice(state.devices), removed: slice(state.removed), blocks: slice(state.blocks), lifts: slice(state.lifts), freezes: slice(state.freezes),
    };
    return json(body);
  }

  /**
   * Device table P16, P21, T52 (service effect): a block commits whole (target removed, freeze line, record
   * kept); a lift ends that block's service line. Each signer must be a registered member older than the target.
   */
  private frozen(registry: { freezes: readonly SnapshotFreezeLine[] }, no: number): boolean {
    return registry.freezes.some((line) => no > line.after);
  }

  private async safetyRecord(account: string, body: { record?: unknown }): Promise<Response> {
    let record: SafetyRecord;
    try {
      record = parseSafetyRecord(body.record);
    } catch (error) {
      if (error instanceof AccountRecordError) return problem(400, "record_invalid", error.message);
      throw error;
    }
    if (!isDeviceSafetyRecord(record)) return problem(400, "record_invalid", "Send a block or a device's lift");
    if (!await verifySafetyRecord(record)) return problem(400, "signature_invalid", "The signature does not hold");
    if (record.account !== account) return problem(403, "account_mismatch", "The record is for another account");
    const registry = this.registry(account);
    const signer = registry.devices.get(record.signer);
    if (signer && this.frozen(registry, signer.no)) return problem(403, "frozen", "A key a block freezes signs nothing");
    if (!signer || signer.removed || signer.no !== record.signer_no) return problem(403, "signer_not_member", "The signer is not a device of this account");
    if (record.kind === "block") {
      const target = registry.devices.get(record.target);
      if (!target || target.no !== record.target_no) return problem(403, "unknown_target", "The target is not where the block says");
      if (signer.no >= target.no) return problem(403, "signer_not_older", "Only a device older than the target blocks it");
      if (!registry.blocks.some((held) => held.id === record.id)) {
        if (target.removed) return problem(409, "target_removed", "The target is already removed");
        target.removed = true;
        registry.blocks.push(record);
        registry.freezes.push({ block: record.id, target: record.target, after: record.target_no });
        registry.version += 1;
      }
      return json({ id: record.id });
    }
    const block = registry.blocks.find((held) => held.id === record.target);
    if (!block) return problem(404, "not_found", "No such block");
    if (record.signer_no >= block.target_no) return problem(403, "signer_not_older", "Only a device older than the blocked one lifts it");
    // T52: as the service, only a list-eligible device lifts
    if (!signer.eligible) return problem(403, "not_eligible", "This device cannot lift a block yet");
    if (!registry.lifts.some((held) => held.id === record.id)) {
      registry.lifts.push(record);
      registry.freezes = registry.freezes.filter((line) => line.block !== block.id);
      registry.version += 1;
    }
    return json({ id: record.id });
  }

  /** An account's signed list as the service holds it, for a test to look at; null for an account that has none. */
  accountList(account: string): { readonly id: string; readonly entries: readonly string[]; readonly head: ListPlace; readonly state: ListState } | null {
    const list = this.listOfAccount(account);
    return list === undefined ? null : { id: list.id, entries: [...list.texts], head: headOf(list), state: list.state };
  }

  /** Adds one lie (ListTamper) to what the list routes tell of `list`; rules stack in the order added, a later field over an earlier, until untamperList. */
  tamperList(list: string, rule: ListTamper): void {
    const held = this.lists.get(list);
    if (held === undefined) throw new Error("No such list");
    const forkAt = rule.fork?.[0] === undefined ? null : seqOfText(rule.fork[0]);
    if (rule.fork !== undefined && forkAt === null) throw new Error("A fork starts with an entry");
    if (rule.answerList !== undefined && !this.lists.has(rule.answerList)) throw new Error("No such list to answer with");
    const reader = rule.reader;
    const session = reader !== undefined && "token" in reader ? this.tokens.get(reader.token) : undefined;
    if (reader !== undefined && "token" in reader && session === undefined) throw new Error("No such token");
    held.tamper.push({ rule, family: session?.family ?? null, server_id: reader !== undefined && "server_id" in reader ? reader.server_id : null });
  }

  untamperList(list: string): void { this.lists.get(list)?.tamper.splice(0); }

  /** OVIS_LIST_ACCOUNTS as the service reads it: `all` once an entry is `*`, else the account ids it names. */
  private listNamed(): "all" | string[] {
    const named: string[] = [];
    for (const entry of this.listAccounts.split(",")) {
      const account = entry.trim();
      if (account === "*") return "all";
      if (ACCOUNT_ID.test(account)) named.push(account);
    }
    return named;
  }

  private listsOn(account: string): boolean {
    const named = this.listNamed();
    return named === "all" || named.includes(account);
  }

  /** No account may have a list: every /v2 route is an unknown one before anything is read or counted. */
  private listsOff(): boolean {
    const named = this.listNamed();
    return named !== "all" && named.length === 0;
  }

  private listOfAccount(account: string): FakeList | undefined {
    const id = this.accountLists.get(account);
    return id === undefined ? undefined : this.lists.get(id);
  }

  /** The caller's account's list `id`, or undefined: another account's list is not told apart from none. */
  private ownList(account: string, id: string): FakeList | undefined {
    const list = this.lists.get(id);
    return list?.account === account ? list : undefined;
  }

  /** A listing the account's devices take as the account's: what the mailbox calls confirmed. */
  private confirmed(row: FakePc): boolean {
    return !(this.opensAll && row.listed_by_device === true);
  }

  private bearerSession(request: Request): Session | undefined {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const session = bearer === undefined ? undefined : this.tokens.get(bearer);
    return session === undefined || this.now() >= session.expires || this.revokedFamilies.has(session.family) ? undefined : session;
  }

  /** The key a sign-in registered (registerSessionKey), while it is a device of the account that is not removed. */
  private signInKey(account: string, family: string): { key: string; frozen: boolean } | undefined {
    const registry = this.registries.get(account);
    for (const [key, of] of this.keyFamily) {
      const device = of === family ? registry?.devices.get(key) : undefined;
      if (registry !== undefined && device !== undefined && !device.removed) return { key, frozen: this.frozen(registry, device.no) };
    }
    return undefined;
  }

  /** frozenSignIn, as the PC invites use it: the key this sign-in registered stands above a block's freeze line. */
  private frozenSignIn(account: string, family: string): boolean {
    return this.signInKey(account, family)?.frozen === true;
  }

  /** A device writes only from an app's own sign-in (a device code can be typed for someone else's screen) that no standing block freezes. Null when it may. */
  private writeRefusal(account: string, family: string): Response | null {
    if (this.deviceFamilies.has(family)) return this.v2Problem(403, "own_sign_in_required", "Sign in on this device first");
    if (this.frozenSignIn(account, family)) return this.v2Problem(403, "frozen", "A sign-in a block freezes places nothing");
    return null;
  }

  /** The sign-in behind a claim still locks: still there, an app's own, not frozen. */
  private signInStands(account: string, family: string): boolean {
    return !this.revokedFamilies.has(family) && this.writeRefusal(account, family) === null;
  }

  private v2Json(body: Record<string, unknown>, status = 200, retryAfter?: number): Response {
    const answer = new Response(JSON.stringify({ ...body, now: Math.floor(this.now() / 1000) }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (retryAfter !== undefined) answer.headers.set("retry-after", String(Math.max(1, retryAfter)));
    return answer;
  }

  private v2Problem(status: number, code: string, message: string, details: Record<string, unknown> = {}, retryAfter?: number): Response {
    return this.v2Json({ error: { ...details, code, message } }, status, retryAfter);
  }

  private v2Unknown(): Response { return this.v2Problem(404, "not_found", "Unknown request"); }

  private v2Invalid(): Response { return this.v2Problem(400, "invalid_request", "The body or the query is not in its form"); }

  private async v2Body(request: Request, max: number): Promise<Record<string, unknown> | Response> {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > max) return this.v2Problem(413, "too_large", "The body is too large");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return this.v2Problem(400, "invalid_json", "The body is not JSON");
    }
    return isRecord(value) ? value : this.v2Invalid();
  }

  /** A fixed window of `window` ms, as withinRateLimit's, answering 429 `rate_limited` with retry-after past `max`. */
  private listLimited(key: string, max: number, window: number): Response | null {
    const now = this.now();
    const counter = this.counters.get(key);
    if (counter === undefined || now - counter.start >= window) {
      this.counters.set(key, { start: now, count: 1 });
      return null;
    }
    counter.count += 1;
    return counter.count <= max ? null : this.v2Problem(429, "rate_limited", "Too many requests; try again later", {}, Math.ceil((counter.start + window - now) / 1000));
  }

  /** What the service tells `caller` of the list's log, with every lie a test turned on for it. */
  private servedLog(list: FakeList, caller: ListCaller): { readonly id: string; readonly texts: readonly string[]; readonly head: ListPlace; readonly cuts: readonly number[] } {
    const lie = this.tamperFor(list, caller);
    const base = (lie.answerList === undefined ? undefined : this.lists.get(lie.answerList)) ?? list;
    let texts = [...base.texts];
    const forkAt = lie.fork?.[0] === undefined ? null : seqOfText(lie.fork[0]);
    if (lie.fork !== undefined && forkAt !== null) texts = [...texts.slice(0, forkAt), ...lie.fork];
    if (lie.withholdAfter !== undefined) texts = texts.slice(0, Math.max(0, lie.withholdAfter) + 1);
    if (lie.inject !== undefined) texts = [...texts, ...lie.inject];
    const flip = lie.flipEntry;
    const flipped = flip === undefined ? undefined : texts[flip.seq];
    if (flip !== undefined && flipped !== undefined) texts[flip.seq] = flipEntryText(flipped, flip.byte);
    const last = texts.length - 1;
    const head = lie.head ?? { seq: last, hash: hashOfText(texts[last] ?? "") ?? base.hashes[last] ?? "0".repeat(64) };
    return { id: base.id, texts, head, cuts: lie.pages ?? [] };
  }

  /** The wraps the service tells `caller` that `member` has: the latest LIST_WRAPS_READ epochs, ascending. */
  private servedWraps(list: FakeList, caller: ListCaller, member: string): { epoch: number; wrap: string }[] {
    const lie = this.tamperFor(list, caller);
    const base = (lie.answerList === undefined ? undefined : this.lists.get(lie.answerList)) ?? list;
    const wraps = new Map(base.wraps.get(member) ?? []);
    for (const wrap of lie.wraps ?? []) if (wrap.member === member) wraps.set(wrap.epoch, wrap.wrap);
    const flip = lie.flipWrap;
    const flipped = flip?.member === member ? wraps.get(flip.epoch) : undefined;
    if (flip !== undefined && flipped !== undefined) wraps.set(flip.epoch, flipText(flipped, flip.byte));
    return [...wraps].sort(([a], [b]) => a - b).slice(-LIST_WRAPS_READ).map(([epoch, wrap]) => ({ epoch, wrap }));
  }

  private tamperFor(list: FakeList, caller: ListCaller): ListTamper {
    let lie: ListTamper = {};
    for (const { rule, family, server_id } of list.tamper) {
      if ((family !== null && caller.family !== family) || (server_id !== null && caller.server_id !== server_id)) continue;
      lie = { ...lie, ...rule };
    }
    return lie;
  }

  /** One page of the log after `after` (from entry 0 for null), as served to `caller`. */
  private logPage(list: FakeList, caller: ListCaller, after: number | null, limit: number): Response {
    const served = this.servedLog(list, caller);
    const from = after === null ? 0 : after + 1;
    const cut = Math.min(Number.POSITIVE_INFINITY, ...served.cuts.filter((seq) => seq >= from));
    const entries: string[] = [];
    let chars = 0;
    for (let seq = from; seq < served.texts.length && seq <= cut && entries.length < limit; seq++) {
      const text = served.texts[seq]!;
      // about 1 MiB of text a page, and never an empty page while entries follow
      if (entries.length > 0 && chars + text.length > LIST_PAGE_CHARS) break;
      entries.push(text);
      chars += text.length;
    }
    return this.v2Json({ list: list.id, after, entries, head: served.head, more: from + entries.length < served.texts.length });
  }

  /** The mailbox pull's `with_list`: the list's id and head for a PC the account lists confirmed, else null. */
  private mailboxList(serverId: string, account: string, row: FakePc | undefined): { id: string; head: ListPlace } | null {
    const list = this.listsOn(account) ? this.listOfAccount(account) : undefined;
    if (list === undefined || row === undefined || !this.confirmed(row)) return null;
    const served = this.servedLog(list, { server_id: serverId, endpoint: row.public_key });
    return { id: served.id, head: served.head };
  }

  /**
   * The signed list's routes (Part D of the account service, as the service builds them; docs/account-list.md, "The list
   * routes in tests"). Every answer, a refusal included, carries the service's clock as `now`, in seconds.
   */
  private async v2(request: Request, url: URL): Promise<Response> {
    if (this.listsOff()) return this.v2Unknown();
    const path = url.pathname;
    if (path.startsWith("/v2/pc/")) return request.method === "POST" ? await this.v2Pc(request, path) : this.v2Unknown();
    const named = /^\/v2\/lists\/([^/]+)\/(log|wraps|entries|claims|posts)$/.exec(path);
    const route = path === "/v2/lists" ? `${request.method} genesis` : path === "/v2/lists/mine" ? `${request.method} mine` : named === null ? null : `${request.method} ${named[2]}`;
    if (route === null || !LIST_ROUTES.includes(route)) return this.v2Unknown();
    const session = this.bearerSession(request);
    // with only some accounts named, a missing sign-in is not told apart from an account that is not named
    if (session === undefined) return this.listNamed() === "all" ? this.v2Problem(401, "unauthorized", "Sign in again") : this.v2Unknown();
    const account = session.account;
    if (!this.listsOn(account)) return this.v2Unknown();
    const id = named?.[1] ?? "";
    // a device's batch is counted once its body is read: removals alone by a signer of the list spend that signer's own counter
    if (route === "POST entries") return await this.deviceBatch(request, session, id);
    const limited = this.listLimited(`requests:${account}`, ACCOUNT_REQUESTS_PER_WINDOW, LIMIT_WINDOW_MS);
    if (limited !== null) return limited;
    const caller = { family: session.family };
    switch (route) {
      case "POST genesis": return await this.genesis(request, session);
      case "GET mine": {
        const list = this.listOfAccount(account);
        if (list === undefined) return this.v2Json({ list: null });
        const served = this.servedLog(list, caller);
        return this.v2Json({ list: served.id, head: served.head });
      }
      case "GET log": {
        const query = Object.fromEntries(url.searchParams);
        const after = query.after === undefined ? null : listNumber(query.after);
        const limit = query.limit === undefined ? LIST_PAGE_MAX : /^[1-9][0-9]{0,2}$/.test(query.limit) ? Number(query.limit) : 0;
        if (!Object.keys(query).every((name) => name === "after" || name === "limit") || (query.after !== undefined && after === null) || limit < 1 || limit > LIST_PAGE_MAX) return this.v2Invalid();
        const list = this.ownList(account, id);
        return list === undefined ? this.v2Unknown() : this.logPage(list, caller, after, limit);
      }
      case "GET wraps": {
        const list = this.ownList(account, id);
        if (list === undefined) return this.v2Unknown();
        const member = url.searchParams.get("member");
        if (member === null || !isListKeyEncoding(member)) return this.v2Invalid();
        return this.v2Json({ wraps: this.servedWraps(list, caller, member) });
      }
      case "POST claims": return await this.claim(request, session, id);
      case "GET claims": {
        const list = this.ownList(account, id);
        if (list === undefined) return this.v2Unknown();
        return this.v2Json({ claims: this.liveClaims(list).map(({ key, enc, card, at }) => ({ key, enc, card, until: untilOf(at) })) });
      }
      default: {
        const list = this.ownList(account, id);
        if (list === undefined) return this.v2Unknown();
        return this.v2Json({ posts: this.livePosts(list).map(([endpoint, { server_id, key, enc, card, at }]) => ({ endpoint, server_id, key, enc, card, until: untilOf(at) })) });
      }
    }
  }

  /** POST /v2/lists: entry 0 of the account's one list, from an app's own sign-in, not frozen, fresh or proving its key. */
  private async genesis(request: Request, session: Session): Promise<Response> {
    const body = await this.v2Body(request, LIST_BODY.genesis);
    if (body instanceof Response) return body;
    const wraps = wrapsOf(body.wraps);
    if (!hasOnly(body, ["entry"], ["wraps", "key_proof"]) || typeof body.entry !== "string" || wraps === null || (body.key_proof !== undefined && keyProofOf(body.key_proof) === null)) return this.v2Invalid();
    const refused = this.writeRefusal(session.account, session.family);
    if (refused !== null) return refused;
    let first: HeldEntry;
    try {
      first = (await firstState(entryFromText(body.entry))).first;
    } catch (error) {
      if (error instanceof ListEntryError) return this.v2Problem(400, error.code, error.message, { index: 0 });
      throw error;
    }
    let state: ListState;
    try {
      state = firstListState(first, LIST_SERVICE_LEVEL);
    } catch (error) {
      if (error instanceof ListKindError) return this.v2Problem(400, "entry_refused", "Entry 0 is no genesis this service can read", { index: 0, outcome: "no_effect", reason: "entry_invalid" });
      throw error;
    }
    const kind = readKind(first.body);
    if (kind?.kind !== "genesis" || kind.account !== session.account) return this.v2Problem(403, "account_mismatch", "The genesis names another account");
    const exists = (): Response | null => {
      const held = this.listOfAccount(session.account);
      return held === undefined ? null : this.v2Problem(409, "list_exists", "This account has a list", { list: held.id, head: headOf(held) });
    };
    const before = exists();
    if (before !== null) return before;
    const wrapAt = wrapRefusal(wraps, state);
    if (wrapAt !== null) return this.wrapInvalid(wrapAt);
    const fresh = await this.freshOrProved(session, body.key_proof, "list-genesis", first.hash, "");
    if (fresh !== null) return fresh;
    // judged again in the write: another genesis of the account may have come, or the sign-in gone, while this one was checked
    const raced = exists();
    if (raced !== null) return raced;
    if (this.revokedFamilies.has(session.family)) return this.v2Problem(401, "unauthorized", "Sign in again");
    const fell = this.writeRefusal(session.account, session.family);
    if (fell !== null) return fell;
    const list: FakeList = { id: first.hash, account: session.account, texts: [body.entry], hashes: [first.hash], last: first, state, wraps: new Map(), claims: new Map(), posts: new Map(), additions: [], tamper: [] };
    for (const wrap of wraps) storeWrap(list, wrap);
    this.lists.set(list.id, list);
    this.accountLists.set(session.account, list.id);
    return this.v2Json({ list: list.id, head: headOf(list) }, 201);
  }

  /**
   * The second lock's age rule for a device (`mayAddPc`): an own sign-in made in the last ten minutes, or older with a
   * proof by the key registered for that very sign-in over a challenge of POST /v1/pcs/challenge. A proof that is sent is
   * judged, its challenge spent, whatever the sign-in's age. Null when it passes.
   */
  private async freshOrProved(session: Session, proof: unknown, purpose: ListKeyProofPurpose, list: string, slot: string): Promise<Response | null> {
    const recent = this.now() - (this.signedInAt.get(session.family) ?? Number.NEGATIVE_INFINITY) <= REAUTH_MS;
    const stale = this.v2Problem(403, "session_not_fresh", "Sign in again on this device first");
    const shaped = keyProofOf(proof);
    if (shaped === null) return recent ? null : stale;
    const held = this.pcAddChallenges.get(shaped.challenge_id);
    if (held?.family === session.family) this.pcAddChallenges.delete(shaped.challenge_id);
    if (held === undefined || held.family !== session.family || this.now() > held.expires) return this.v2Problem(400, "challenge_invalid", "Ask for a new challenge and sign it");
    const key = this.signInKey(session.account, session.family);
    const proved = key !== undefined && !key.frozen
      && await verifyKeyProof(key.key, keyProofBytes([purpose, session.account, list, slot, shaped.challenge_id, held.challenge]), shaped.signature);
    return proved || recent ? null : stale;
  }

  /** POST /v2/lists/{list}/claims: a device claims its member key with the card its `device` entry will carry. */
  private async claim(request: Request, session: Session, id: string): Promise<Response> {
    const body = await this.v2Body(request, LIST_BODY.small);
    if (body instanceof Response) return body;
    const { key, enc, card } = body;
    if (!hasOnly(body, ["key", "enc", "card"], ["key_proof"]) || typeof key !== "string" || typeof enc !== "string" || typeof card !== "string" || card.length !== CARD_SIGNATURE_CHARS
      || (body.key_proof !== undefined && keyProofOf(body.key_proof) === null)) return this.v2Invalid();
    const refused = this.writeRefusal(session.account, session.family);
    if (refused !== null) return refused;
    const list = this.ownList(session.account, id);
    if (list === undefined) return this.v2Unknown();
    if (!isListKey(key) || !isListKey(enc)) return this.v2Invalid();
    if (!await cardHolds({ key, enc, list: list.id, endpoint: null, invite: null }, card)) return this.v2Problem(400, "card_invalid", "The card is not that key's for this list");
    const fresh = await this.freshOrProved(session, body.key_proof, "list-claim", list.id, key);
    if (fresh !== null) return fresh;
    // one claim per sign-in and list, and one per key and list: a later claim of a key takes it over
    for (const [claimed, held] of list.claims) if (held.family === session.family && claimed !== key) list.claims.delete(claimed);
    const at = this.now();
    list.claims.set(key, { family: session.family, enc, card, at });
    return this.v2Json({ key, until: untilOf(at) });
  }

  /** The claims that still lock, oldest first: at most ten minutes old, by a sign-in still there, an app's own of the account, not frozen. */
  private liveClaims(list: FakeList): (ListClaim & { readonly key: string })[] {
    return [...list.claims].filter(([, claim]) => this.now() - claim.at <= LIST_CLAIM_MS && this.signInStands(list.account, claim.family))
      .map(([key, claim]) => ({ key, ...claim })).sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
  }

  /** The posts that still lock, by endpoint, oldest first: at most ten minutes old, of a PC the account still lists. */
  private livePosts(list: FakeList): [string, ListPost][] {
    return [...list.posts].filter(([, post]) => this.now() - post.at <= LIST_CLAIM_MS && this.directories.get(list.account)?.has(post.server_id) === true)
      .sort(([a, x], [b, y]) => x.at - y.at || (a < b ? -1 : 1));
  }

  /**
   * POST /v2/lists/{list}/entries. Counted before it is judged: removals alone whose first entry verifies under a signer of
   * the list spend that signer's own counter, so nothing else the account's sign-ins send can stand in a removal's way;
   * everything else, a body out of form included, spends the account's requests.
   */
  private async deviceBatch(request: Request, session: Session, id: string): Promise<Response> {
    const account = session.account;
    const body = await this.v2Body(request, LIST_BODY.entries);
    const texts = body instanceof Response ? null : entriesOf(body.entries);
    const wraps = body instanceof Response ? null : wrapsOf(body.wraps);
    if (body instanceof Response || !hasOnly(body, ["entries"], ["wraps"]) || texts === null || wraps === null) {
      return this.listLimited(`requests:${account}`, ACCOUNT_REQUESTS_PER_WINDOW, LIMIT_WINDOW_MS) ?? (body instanceof Response ? body : this.v2Invalid());
    }
    const list = this.ownList(account, id);
    const batch = parseTexts(texts);
    const first = Array.isArray(batch) ? batch[0] : undefined;
    const removals = list !== undefined && first !== undefined && Array.isArray(batch) && batch.every(({ body: entry }) => entry.kind === "remove")
      && await verifySignature(first.entry.body, first.entry.signature, first.body.signer) && signerPower(list.state, first.body.signer) !== null;
    const limited = removals
      ? this.listLimited(`removals:${first!.body.signer}:${account}`, this.listLimits.removalsPerWindow, LIMIT_WINDOW_MS)
      : this.listLimited(`requests:${account}`, ACCOUNT_REQUESTS_PER_WINDOW, LIMIT_WINDOW_MS);
    if (limited !== null) return limited;
    if (!Array.isArray(batch)) return this.v2Problem(400, batch.code, batch.message, { index: batch.index });
    if (list === undefined) return this.v2Unknown();
    const refused = this.writeRefusal(account, session.family);
    if (refused !== null) return refused;
    return await this.place(list, batch, wraps, { family: session.family });
  }

  /** The PC routes of the list: the relay-key proof in the body, one challenge spent per call. */
  private async v2Pc(request: Request, path: string): Promise<Response> {
    const shape = Object.hasOwn(PC_SHAPES, path) ? PC_SHAPES[path] : undefined;
    if (shape === undefined) return this.v2Unknown();
    const body = await this.v2Body(request, shape.size);
    if (body instanceof Response) return body;
    if (!hasOnly(body, [...PC_PROOF, ...shape.members], shape.optional ?? []) || !pcBodyFormed(path, body)) return this.v2Invalid();
    if (typeof body.server_id !== "string" || !/^[0-9a-f]{32}$/.test(body.server_id)) return this.v2Invalid();
    const key = proofKey(body.public_key);
    if (!key || deriveServerId(key) !== body.server_id) return this.v2Problem(400, "server_key_mismatch", "That key does not give that server_id");
    if (!this.takeProof({ server_id: body.server_id, challenge_id: body.challenge_id, proof: body.proof })) return this.v2Problem(401, "proof_invalid", "Ask for a new challenge and answer it");
    const serverId = body.server_id;
    const endpoint = body.public_key as string;
    const limited = this.listLimited(`list-pc:${serverId}`, this.listLimits.pcCallsPerMinute, 60_000);
    if (limited !== null) return limited;
    const caller = { server_id: serverId, endpoint };
    if (path === "/v2/pc/list") {
      const account = body.account as string;
      if (!this.listsOn(account)) return this.v2Unknown();
      const list = this.listOfAccount(account);
      const listed = this.directories.get(account)?.has(serverId) === true;
      // a listing in any state (the PC needs the id for its card), or a row in the list (a PC removed from the directory)
      if (list === undefined) return listed ? this.v2Json({ list: null }) : this.v2Unknown();
      if (!listed && rowOf(list.state.pcs, endpoint) === null) return this.v2Unknown();
      const served = this.servedLog(list, caller);
      return this.v2Json({ list: served.id, head: served.head });
    }
    const list = this.lists.get(body.list as string);
    if (list === undefined || !this.listsOn(list.account)) return this.v2Unknown();
    const listing = this.directories.get(list.account)?.get(serverId);
    if (path === "/v2/pc/list/log" || path === "/v2/pc/list/wraps") {
      // a listing the account confirmed, or a row in the list, removed or not: a removed PC reads its removal
      if (!(listing !== undefined && this.confirmed(listing)) && rowOf(list.state.pcs, endpoint) === null) return this.v2Unknown();
      if (path === "/v2/pc/list/log") return this.logPage(list, caller, body.after === undefined ? null : body.after as number, body.limit === undefined ? LIST_PAGE_MAX : body.limit as number);
      if (!isListKeyEncoding(body.member as string)) return this.v2Invalid();
      return this.v2Json({ wraps: this.servedWraps(list, caller, body.member as string) });
    }
    if (path === "/v2/pc/list/entries") {
      const batch = parseTexts(body.entries as string[]);
      if (!Array.isArray(batch)) return this.v2Problem(400, batch.code, batch.message, { index: batch.index });
      // a PC in the list, or one whose every entry is a join naming it (the proof is the join's second lock)
      if (!holdsPc(list.state, endpoint) && !batch.every(({ body: entry }) => namesEndpoint(entry, endpoint))) return this.v2Unknown();
      return await this.place(list, batch, wrapsOf(body.wraps)!, caller);
    }
    // POST /v2/pc/list/keys: only while the account lists this PC, so that the proof locks something
    if (listing === undefined) return this.v2Unknown();
    const posted = { key: body.key as string, enc: body.enc as string, card: body.card as string };
    if (!isListKey(posted.key) || !isListKey(posted.enc)) return this.v2Invalid();
    if (!await cardHolds({ ...posted, list: list.id, endpoint, invite: null }, posted.card)) return this.v2Problem(400, "card_invalid", "The card is not that key's for this list and this PC");
    const at = this.now();
    list.posts.set(endpoint, { ...posted, server_id: serverId, at });
    return this.v2Json({ endpoint, key: posted.key, until: untilOf(at) });
  }

  /**
   * Places a batch at the head, whole or not at all, as the service judges it: the first entry at the head (the
   * compare-and-swap); then entry by entry, each holds after the one before it and counts for the library on the service's
   * state, and what only the service judges (no `carried` yet, an invite from a sign-in and by its clock, a join by the
   * PC it names, the list's size); then the second lock, the wraps, and the head again with the writer and the budget, at
   * the write. From the second lock to the write nothing waits, so of two writers at one head exactly one is placed.
   */
  private async place(list: FakeList, batch: readonly ParsedEntry[], wraps: readonly ListWrap[], caller: ListCaller): Promise<Response> {
    const lie = this.tamperFor(list, caller);
    if (lie.headMoved === true) return this.headMoved(list);
    const head = headOf(list);
    const first = batch[0]!;
    if (first.body.list !== list.id) return this.v2Problem(400, "chain_broken", "list is not this list's id", { index: 0 });
    if (first.body.seq !== head.seq + 1 || first.body.prev !== head.hash) return this.notAtHead(list, batch);
    const judged = list.last;
    let last = judged;
    let state = list.state;
    const nowS = Math.floor(this.now() / 1000);
    const held: HeldEntry[] = [];
    const claims: { index: number; key: string }[] = [];
    const posts: { index: number; key: string; endpoint: string }[] = [];
    const limits = this.listLimits;
    for (const [index, { entry }] of batch.entries()) {
      try {
        last = await entryHolds(entry, last);
      } catch (error) {
        if (error instanceof ListEntryError) return this.v2Problem(400, error.code, error.message, { index });
        throw error;
      }
      const kind = readKind(last.body);
      const invite = kind?.kind === "join" ? rowOf(state.invites, last.body.signer) : null;
      const taken = await takeEntry(state, last);
      if (taken.outcome.outcome !== "counts" || kind === null) {
        const reason = "code" in taken.outcome ? taken.outcome.code : null;
        return this.refusedAt(index, taken.outcome.outcome === "counts" ? "no_effect" : taken.outcome.outcome, reason, "A member would not count this entry");
      }
      // carrying members in from before the list has no second lock yet, so the service places none
      if (kind.kind === "carried") return this.refusedAt(index, "service", "carried_not_open", "Carrying members in from before the list is not open yet");
      if (kind.kind === "invite") {
        // an invite lets a PC in with nobody else awake: a PC's key alone opens no way in for a machine
        if (caller.family === undefined) return this.v2Problem(403, "sign_in_required", "An invite is placed by a sign-in of the account", { index });
        if (last.body.issued_at > nowS + LIST_ISSUED_AHEAD_S) return this.refusedAt(index, "service", "issued_at_ahead", "An invite's issued_at is not ahead of the service's clock");
      }
      if (kind.kind === "join") {
        if (invite !== null && nowS > invite.exp) return this.v2Problem(409, "invite_expired", "That invite has expired", { index });
        if (caller.endpoint !== kind.endpoint) return this.v2Problem(403, "pc_proof_required", "A join is placed by the PC it names, with its own proof", { index });
      }
      if (kind.kind === "device") claims.push({ index, key: kind.key });
      if (kind.kind === "pc") posts.push({ index, key: kind.key, endpoint: kind.endpoint });
      const tail = kind.kind === "remove" || kind.kind === "epoch";
      if (last.body.seq >= limits.closedFrom || (!tail && (last.body.seq >= limits.removalsOnlyFrom || JSON.stringify(taken.state).length > limits.stateChars))) {
        return this.v2Problem(409, "list_full", tail ? "This list takes no more entries" : "This list takes only removals now");
      }
      state = taken.state;
      held.push(last);
    }
    const lock = this.lockRefusal(list, claims, posts);
    if (lock !== null) return lock;
    const wrapAt = wrapRefusal(wraps, state);
    if (wrapAt !== null) return this.wrapInvalid(wrapAt);
    if (list.last !== judged) return this.notAtHead(list, batch);
    if (caller.family !== undefined) {
      if (this.revokedFamilies.has(caller.family)) return this.v2Problem(401, "unauthorized", "Sign in again");
      const fell = this.writeRefusal(list.account, caller.family);
      if (fell !== null) return fell;
    }
    const now = this.now();
    const additions = held.filter(({ body }) => LIST_ADDITIONS.includes(body.kind)).length;
    const recent = list.additions.filter((at) => at > now - LIMIT_WINDOW_MS);
    const leaving = recent.length + additions - limits.additionsPerWindow;
    if (additions > 0 && leaving > 0) {
      return this.v2Problem(429, "entry_budget", "Too many devices and invites added to this list; try again later", {}, Math.ceil(((recent[leaving - 1] ?? now) + LIMIT_WINDOW_MS - now) / 1000));
    }
    list.texts.push(...batch.map(({ text }) => text));
    list.hashes.push(...held.map(({ hash }) => hash));
    list.last = held.at(-1)!;
    list.state = state;
    // a lock is used up by the entry it let in
    for (const { key } of claims) list.claims.delete(key);
    for (const { endpoint } of posts) list.posts.delete(endpoint);
    if (lie.dropWraps !== true) for (const wrap of wraps) storeWrap(list, wrap);
    list.additions.splice(0, list.additions.length, ...recent, ...Array<number>(additions).fill(now));
    // the doorbell rings the account's other devices from a budget of its own, never the one admissions ring from
    if (this.withinRateLimit(`list_rings:${list.account}`, LIST_RINGS_PER_WINDOW)) this.ring(list.account, caller.family ?? "");
    return this.v2Json({ list: list.id, head: headOf(list), placed: held.length });
  }

  /** The first entry of the batch whose second lock does not hold now, as its refusal; null when every one holds. */
  private lockRefusal(list: FakeList, claims: readonly { index: number; key: string }[], posts: readonly { index: number; key: string; endpoint: string }[]): Response | null {
    const claimed = this.liveClaims(list);
    const posted = this.livePosts(list);
    const missing = [
      ...claims.filter(({ key }) => !claimed.some((claim) => claim.key === key)).map(({ index }) => ({ index, lock: "claim" })),
      ...posts.filter(({ key, endpoint }) => !posted.some(([at, post]) => at === endpoint && post.key === key)).map(({ index }) => ({ index, lock: "post" })),
    ].sort((a, b) => a.index - b.index)[0];
    if (missing === undefined) return null;
    return missing.lock === "claim"
      ? this.v2Problem(403, "not_claimed", "That device's key has no live claim by a sign-in of this account", { index: missing.index })
      : this.v2Problem(403, "not_posted", "That PC has not posted that key with its own proof, or the account does not list it", { index: missing.index });
  }

  /** `200` with `placed: 0` when the batch stands in the log already, text for text, at the places it names; else `409 head_moved` with the head now. */
  private notAtHead(list: FakeList, batch: readonly ParsedEntry[]): Response {
    const from = batch[0]?.body.seq ?? 0;
    return batch.every(({ text }, at) => list.texts[from + at] === text) ? this.v2Json({ list: list.id, head: headOf(list), placed: 0 }) : this.headMoved(list);
  }

  private headMoved(list: FakeList): Response {
    return this.v2Problem(409, "head_moved", "The list's head is not where this batch starts; read the log and sign again", { head: headOf(list) });
  }

  private refusedAt(index: number, outcome: string, reason: string | null, message: string): Response {
    return this.v2Problem(400, "entry_refused", message, { index, outcome, reason });
  }

  private wrapInvalid(index: number): Response {
    return this.v2Problem(400, "wrap_invalid", "A wrap is 151 characters for the list's current epoch and one of its members' encryption keys", { index });
  }

  private expire(): void {
    const cutoff = this.now() - MAILBOX_TTL_MS;
    for (const [id, box] of this.mailboxes) this.mailboxes.set(id, box.filter(({ at }) => at > cutoff));
  }

  private iso(): string { return new Date(this.now()).toISOString(); }
}

/** One mailbox per PC and account: another account's records can neither fill nor hide this account's. */
function box(serverId: string, account: string): string {
  return `${serverId}\0${account}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function problem(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The level the service reads lists at: a kind at a higher `v` is `cannot_read` there, and so never placed. */
const LIST_SERVICE_LEVEL = 1;
const LIST_ADDITIONS: readonly string[] = ["device", "invite", "pc", "join"];
/** Rings of a list's placements per account in ten minutes, counted apart from the rings of admissions. */
const LIST_RINGS_PER_WINDOW = 10;
/** The latest wraps one read gives of a member. */
const LIST_WRAPS_READ = 256;
const NUMBER_MAX = 999_999_999_999_999;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LIST_NUMBER = /^(?:0|[1-9][0-9]{0,14})$/;
const LIST_ROUTES: readonly string[] = ["POST genesis", "GET mine", "GET log", "GET wraps", "POST entries", "POST claims", "GET claims", "GET posts"];
const PC_PROOF: readonly string[] = ["server_id", "public_key", "challenge_id", "proof"];
const PC_SHAPES: Readonly<Record<string, { readonly size: number; readonly members: readonly string[]; readonly optional?: readonly string[] }>> = {
  "/v2/pc/list": { size: LIST_BODY.small, members: ["account"] },
  "/v2/pc/list/log": { size: LIST_BODY.small, members: ["list"], optional: ["after", "limit"] },
  "/v2/pc/list/wraps": { size: LIST_BODY.small, members: ["list", "member"] },
  "/v2/pc/list/entries": { size: LIST_BODY.entries, members: ["list", "entries"], optional: ["wraps"] },
  "/v2/pc/list/keys": { size: LIST_BODY.small, members: ["list", "key", "enc", "card"] },
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isPlace = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= NUMBER_MAX;
const untilOf = (at: number): number => Math.floor((at + LIST_CLAIM_MS) / 1000);

/** A PC route's own members in their forms, as the service's schema reads them (the proof's members are judged by the proof). */
function pcBodyFormed(path: string, body: Record<string, unknown>): boolean {
  if (path === "/v2/pc/list") return typeof body.account === "string" && ACCOUNT_ID.test(body.account);
  if (typeof body.list !== "string" || !isListHash(body.list)) return false;
  switch (path) {
    case "/v2/pc/list/log": return (body.after === undefined || isPlace(body.after)) && (body.limit === undefined || (isPlace(body.limit) && body.limit >= 1 && body.limit <= LIST_PAGE_MAX));
    case "/v2/pc/list/wraps": return typeof body.member === "string";
    case "/v2/pc/list/entries": return entriesOf(body.entries) !== null && wrapsOf(body.wraps) !== null;
    default: return typeof body.key === "string" && typeof body.enc === "string" && typeof body.card === "string" && body.card.length === CARD_SIGNATURE_CHARS;
  }
}

function headOf(list: FakeList): ListPlace {
  return { seq: list.texts.length - 1, hash: list.last.hash };
}

function rowOf<Row>(rows: { readonly [name: string]: Row }, name: string): Row | null {
  return Object.hasOwn(rows, name) ? (rows[name] ?? null) : null;
}

/** A body read strictly: every required member, and no member but these. */
function hasOnly(body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((name) => Object.hasOwn(body, name)) && Object.keys(body).every((name) => required.includes(name) || optional.includes(name));
}

function listNumber(text: string): number | null {
  return LIST_NUMBER.test(text) ? Number(text) : null;
}

/** A placement's `entries`: 1 to 16 texts. */
function entriesOf(value: unknown): string[] | null {
  return Array.isArray(value) && value.length >= 1 && value.length <= LIST_BATCH_MAX && value.every((text) => typeof text === "string") ? value as string[] : null;
}

/** `wraps` in its JSON form (absent: none): up to 1024 objects of exactly `epoch`, `member` and `wrap`. Their values are judged by wrapRefusal. */
function wrapsOf(value: unknown): ListWrap[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIST_WRAPS_MAX) return null;
  return value.every((wrap) => isRecord(wrap) && hasOnly(wrap, ["epoch", "member", "wrap"]) && isPlace(wrap.epoch) && typeof wrap.member === "string" && typeof wrap.wrap === "string")
    ? value as ListWrap[] : null;
}

/**
 * The index of the first wrap the service does not store, or null: not 151 characters of base64url in one spelling, or
 * not for the epoch current in the state after the batch and one of its wrapKeys. A wrap is not signed: the service
 * checks its length and spelling only.
 */
function wrapRefusal(wraps: readonly ListWrap[], state: ListState): number | null {
  const members = new Set(wrapKeys(state));
  const index = wraps.findIndex((wrap) => wrap.wrap.length !== WRAP_TEXT || oneSpelling(wrap.wrap)?.length !== WRAP_BYTES || wrap.epoch !== state.epoch || !members.has(wrap.member));
  return index < 0 ? null : index;
}

/** A wrap is written once: one already stored for its epoch and member stays, and the later one is dropped. */
function storeWrap(list: FakeList, wrap: ListWrap): void {
  const member = list.wraps.get(wrap.member) ?? new Map<number, string>();
  if (!member.has(wrap.epoch)) member.set(wrap.epoch, wrap.wrap);
  list.wraps.set(wrap.member, member);
}

/** An entry of a batch as sent: its text, the entry and its body in their forms. */
interface ParsedEntry { readonly text: string; readonly entry: Entry; readonly body: EntryBody }

/** Each text as an entry and its body, or the first that is not in its form, with its index. */
function parseTexts(texts: readonly string[]): ParsedEntry[] | { readonly index: number; readonly code: string; readonly message: string } {
  const parsed: ParsedEntry[] = [];
  for (const [index, text] of texts.entries()) {
    try {
      const entry = entryFromText(text);
      parsed.push({ text, entry, body: readBody(entry.body) });
    } catch (error) {
      if (error instanceof ListEntryError) return { index, code: error.code, message: error.message };
      throw error;
    }
  }
  return parsed;
}

/** Whether a body is a `join` whose `endpoint` field is this relay key: read as sent, before anything is judged. */
function namesEndpoint(body: EntryBody, endpoint: string): boolean {
  return body.kind === "join" && body.own.some(({ name, value }) => name === "endpoint" && new TextDecoder().decode(value) === endpoint);
}

function seqOfText(text: string): number | null {
  const parsed = parseTexts([text]);
  return Array.isArray(parsed) ? parsed[0]?.body.seq ?? null : null;
}

function hashOfText(text: string): string | null {
  try {
    return entryHash(entryFromText(text).body);
  } catch (error) {
    if (error instanceof ListEntryError) return null;
    throw error;
  }
}

/** The text with one byte of its body flipped (the middle one unless said), written again in its one spelling. */
function flipEntryText(text: string, byte?: number): string {
  const entry = entryFromText(text);
  const body = new Uint8Array(entry.body);
  const at = byte ?? Math.floor(body.length / 2);
  body[at] = (body[at] ?? 0) ^ 0x01;
  return entryToText({ body, signature: entry.signature });
}

function flipText(text: string, byte?: number): string {
  const bytes = new Uint8Array(fromBase64Url(text));
  const at = byte ?? Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  return toBase64Url(bytes);
}

/** `key_proof` as the service reads it: `{ challenge_id, signature }`, 32 lowercase hex digits and 86 base64url characters; null otherwise. */
function keyProofOf(value: unknown): { challenge_id: string; signature: string } | null {
  if (!isRecord(value) || !hasOnly(value, ["challenge_id", "signature"])) return null;
  const { challenge_id, signature } = value;
  return typeof challenge_id === "string" && /^[0-9a-f]{32}$/.test(challenge_id) && typeof signature === "string" && /^[A-Za-z0-9_-]{86}$/.test(signature)
    ? { challenge_id, signature } : null;
}

/**
 * What a key proof signs: `ovis-pc-add/1` and its values (purpose, account, server_id or list id, listing ID or slot,
 * challenge id, challenge), each as 4 bytes of length (big-endian) and the value, as shared/account-records.ts lays out
 * its own. For the list: `list-genesis` with the list id and "", `list-claim` with the list id and the claimed key.
 */
export function keyProofBytes(values: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const parts = values.map((value) => encoder.encode(value));
  const prefix = encoder.encode("ovis-pc-add/1");
  const bytes = new Uint8Array(prefix.length + parts.reduce((sum, part) => sum + 4 + part.length, 0));
  bytes.set(prefix);
  const view = new DataView(bytes.buffer);
  let offset = prefix.length;
  for (const part of parts) {
    view.setUint32(offset, part.length);
    bytes.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return bytes;
}

async function verifyKeyProof(key: string, bytes: Uint8Array<ArrayBuffer>, signature: string): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey("spki", new Uint8Array(fromBase64Url(key)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, new Uint8Array(fromBase64Url(signature)), bytes);
  } catch {
    return false;
  }
}
