import { canonicalBase64Url } from "../../shared/account-list-entry.ts";
import type { Sealed } from "../../shared/account-list.ts";
import { ACCOUNT_ENROLL_MAX, ACCOUNT_RECORDS_MAX, isAccountKeyEncoding } from "../../shared/account-records.ts";
import type { AccountAddRelay, AccountAddTaken } from "../../shared/machines.ts";
import { toBase64Url } from "../../shared/relay-pair-sas.ts";
import type { Access } from "../access.ts";
import type { ServerContext } from "../dispatch.ts";
import { jsonResponse, readJsonObject, setRequestRoute } from "../http.ts";
import { sameOrigin } from "../machine-security.ts";
import { parseIntroducedPcs } from "./introductions.ts";
import { ACCOUNT_HELD_MAX } from "./holds.ts";
import { AccountAddError } from "../machines.ts";
import { ListAddAway, type AddState } from "./list-add.ts";
import type { JoinOutcome } from "./list-follow.ts";
import { noteListAdd, notePressAsk, pressOnce, waitingForAdd } from "./one-press.ts";
import { applyAccountRecords, applyEnrollment, applyLink, LIST_REMOVED_FROM, type LinkRefusal } from "./records.ts";

const LINK_STATUS: Record<LinkRefusal, number> = {
  record_invalid: 400, signature_invalid: 400, account_mismatch: 409, signer_not_member: 403,
  tombstoned: 409, link_not_owner: 403, key_in_use: 409, account_unavailable: 503, enrolling: 409, removal_pending: 409,
  link_required: 403, unverified_device: 403, pairing_ended: 409, older_device: 403, closed: 409, read_pending: 409,
  replacement_needs_app: 409, list_followed: 409, list_removed: 409,
};

/** What `ovis join` is told where this PC joins no list (POST /api/account/list/join…), by the refusal's name. */
const JOIN_REFUSALS: Readonly<Record<string, string>> = {
  invalid_list: "Name the account, its list and the invite by their ids.",
  other_account: "This PC is in another account.",
  pinned: "This PC already follows another list. Revoke all on this PC to leave its account first.",
  removed: LIST_REMOVED_FROM,
  unavailable: "This PC's relay identity, its list or its keys cannot be read or written.",
  other_adder: "The list holds this PC already, by another entry than this invite's.",
  not_read: "The account's list could not be read from the account service.",
  invite_unknown: "The account's list holds no such invite.",
  invite_revoked: "This invite was revoked.",
  invite_void: "This invite no longer counts: the device that made it is out of the account.",
  invite_spent: "This invite was used already.",
  invite_expired: "This invite ran out.",
  invite_plain: "This invite adds a PC only once a device of the account chooses Add.",
  invite_uses: "This invite lets more than one PC in, so no PC joins with it by itself.",
  not_written: "This PC's join would not count on the account's list.",
};

/**
 * /api/account/* (docs/account.md, "PC API"): drive access only, directly or through the relay,
 * and the app's own mutation guard for changes.
 */
export async function handleAccountRequest(request: Request, pathname: string, context: ServerContext, access: Access): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const fail = (code: string, message: string, status: number) => reply({ error: { code, message } }, status);
  // an add by the list that still runs counts as waiting for Add (GET /api/account/status)
  const noted = (state: AddState): AddState => { noteListAdd(devices, state.state === "waiting" || state.state === "number" || state.state === "confirmed"); return state; };
  const devices = context.services.devices;
  const peer = context.peer;
  // a device that waits to link (it paired with a code made for a PC in no account; docs/account.md, "Who may admit
  // a device") makes two calls here: it reads its own status, and sends its link
  const waiting = peer.kind === "relay" && peer.device.provisional === true ? peer.device.id : null;
  // the one route a watching device may use: its own introduction, over its own session
  if (pathname === "/api/account/introduction" && request.method === "GET") {
    setRequestRoute(pathname);
    const pcs = peer.kind === "relay" ? context.services.accountIntroductions.get(peer.key) : null;
    return pcs ? reply({ pcs }) : fail("introduction_none", "No introduction waits for this device", 404);
  }
  if (waiting !== null && pathname === "/api/account/status" && request.method === "GET") {
    setRequestRoute(pathname);
    // this one body, whatever else the PC holds: it names no account, and no mailbox is read for it (`fresh` is
    // ignored). The read is a moment the device's time is judged at
    if (!devices.provisionalStands(waiting)) return fail("link_required", "This device did not link itself into an account in time. Pair it again.", 403);
    return reply({ account: null, members: 0, unlinked: [waiting], own_word: [], removals: [], adds: [], blocked: [], enrolling: false, blocked_all: false, mailbox: { last_pull_at: null, error: null } });
  }
  const ownLink = waiting !== null && pathname === "/api/account/link" && request.method === "POST";
  if (!ownLink && (access.level !== "full" || access.role !== "drive")) return fail("read_only", "this device can only watch", 403);
  if (pathname === "/api/account/status" && request.method === "GET") {
    setRequestRoute(pathname);
    const mailbox = context.services.accountMailbox;
    // a client about to enroll another PC reads this one's removals after its mailbox, so one waiting there counts too
    const fresh = new URL(request.url).searchParams.get("fresh") === "1" ? await mailbox.freshen() : undefined;
    const blocked = [...new Set([...devices.tombstoneKeys(), ...mailbox.waitingRemoveKeys(), ...context.services.accountHolds.list()])];
    return reply({
      account: devices.account(), ...(devices.accountPolicyActive() ? { pc_add_from_account: devices.accountError === null ? true : "unavailable" } : {}),
      // a PC its account stopped listing: a device sends it no link, and an add at the PC brings it back (docs/account.md)
      ...(devices.addAtPcRequired() ? { pc_add_required: true } : {}),
      ...devices.accountRows(), removals: devices.accountRemovals(), adds: devices.accountAdds(), blocked,
      enrolling: context.services.accountHolds.enrolling(), blocked_all: mailbox.holdsEveryAdd(), ...(fresh === undefined ? {} : { fresh }), mailbox: { last_pull_at: mailbox.lastPullAt, error: mailbox.error },
      // a yes or no only, never the account asked for: the account is named here once this PC is in it
      waiting_for_add: waitingForAdd(devices),
    });
  }
  if (pathname === "/api/account/list" && request.method === "GET") {
    setRequestRoute(pathname);
    // this PC's own window and CLI alone (dispatch.ts ownWindow)
    const list = context.services.accountList;
    return list === null ? fail("not_found", "This PC follows no list", 404) : reply(list.status());
  }
  if (pathname === "/api/account/list/add" && request.method === "GET") {
    setRequestRoute(pathname);
    // this PC's own window and CLI alone (dispatch.ts ownWindow): the number is shown only at this PC
    const add = context.services.listAdd;
    if (add === null) return fail("not_found", "This PC follows no list", 404);
    return reply(noted(await add.state()));
  }
  if (request.method !== "POST") return fail("method_not_allowed", "use POST", 405);
  if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return fail("invalid_origin", "Manage the account from this app", 403);
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const serverId = peer.kind === "relay" ? peer.serverId : context.services.relay.currentIdentity()?.server_id ?? null;
  switch (pathname) {
    case "/api/account/relay-account": {
      setRequestRoute(pathname);
      // the account this PC asks its relay pass under (docs/relay.md, "Relay pass"): named over a direct
      // connection with drive access (the PC's own screen, after listing it), or through the relay only by a
      // member of this PC's own account
      const account = body.account;
      // null forgets the one named, over a direct connection only and only on a PC in no account (`ovis join` that ended
      // unbound puts back what it found): a PC bound to an account keeps the name its pass is asked under
      if (account === null && peer.kind !== "relay") {
        if (devices.account() !== null) return fail("in_account", "This PC is in an account: its name stays", 409);
        context.services.relay.clearRelayAccount();
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      if (typeof account !== "string") return fail("invalid_account", "Name the account", 400);
      if (peer.kind === "relay" && !(devices.isAccountApproverSession(peer.device.id, peer.key) && devices.account() === account)) return fail("account_required", "Name this PC's account from a device linked to it", 403);
      if (!context.services.relay.setRelayAccount(account)) return fail("invalid_account", "Name the account", 400);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    case "/api/account/pc-proof": {
      setRequestRoute(pathname);
      // this PC's own window or CLI alone (dispatch.ts ownWindow): the proof lists the PC again after its leave
      try { return reply(await context.services.accountMailbox.listingProof()); }
      catch (error) { return fail("account_unavailable", error instanceof Error ? error.message : String(error), 503); }
    }
    case "/api/account/list/pin": {
      setRequestRoute(pathname);
      // a person at this PC names the list of its account: this PC's own window and CLI alone (dispatch.ts ownWindow)
      const list = context.services.accountList;
      if (list === null) return fail("not_found", "This PC follows no list", 404);
      if (typeof body.list !== "string") return fail("invalid_list", "Name the list by its id", 400);
      const named = await list.wantList(body.list);
      if ("status" in named) return reply(named.status);
      const refusals = {
        invalid_list: ["Name the list by its id: 64 characters of 0-9 and a-f", 400],
        not_in_account: ["Add this PC to your account first.", 409],
        pinned: ["This PC already follows another list. Revoke all on this PC to leave its account first.", 409],
        removed: [LIST_REMOVED_FROM, 409],
        unavailable: ["This PC's list or its keys cannot be read or written.", 503],
      } as const;
      const [message, status] = refusals[named.refused];
      return fail(named.refused === "removed" ? "list_removed" : named.refused, message, status);
    }
    case "/api/account/list/add": {
      setRequestRoute(pathname);
      // a person at this PC adds it to an account that keeps a signed list (dispatch.ts ownWindow): the PC posts its
      // card, and shows the number to compare with the phone that adds it. `no_list`: the account keeps none
      const add = context.services.listAdd;
      if (add === null) return fail("not_found", "This PC follows no list", 404);
      const account = body.account;
      if (typeof account !== "string") return fail("invalid_account", "Name the account", 400);
      // as one press: the account named for this PC, a PC in no account, and never one that account's list removed
      if (context.services.relay.savedRelayAccount() !== account) return fail("account_mismatch", "This PC was set up for another account. Sign in to that one, or add this PC again.", 409);
      if (devices.account() !== null) return fail("in_account", "This PC is already in an account", 409);
      if (devices.listRemovedFrom(account)) return fail("list_removed", LIST_REMOVED_FROM, 409);
      try { return reply(noted(await add.start(account))); }
      catch (error) {
        if (!(error instanceof ListAddAway)) throw error;
        return fail("account_unavailable", error.message, 503);
      }
    }
    case "/api/account/list/add/confirm": {
      setRequestRoute(pathname);
      // the person at this PC says the phone shows the same number, and says which: only that names the list
      const add = context.services.listAdd;
      if (add === null) return fail("not_found", "This PC follows no list", 404);
      if (typeof body.digits !== "string" || !/^[0-9]{6}$/.test(body.digits)) return fail("invalid_digits", "Send the six digits this PC shows", 400);
      return reply(noted(await add.confirm(body.digits)));
    }
    case "/api/account/list/add/cancel": {
      setRequestRoute(pathname);
      const add = context.services.listAdd;
      if (add === null) return fail("not_found", "This PC follows no list", 404);
      return reply(noted(await add.cancel()));
    }
    case "/api/account/list/join":
    case "/api/account/list/join/prepare":
    case "/api/account/list/join/body":
    case "/api/account/list/join/place": {
      setRequestRoute(pathname);
      // `ovis join` at this PC, with the line of an invite that names the account's list (dispatch.ts ownWindow): a
      // person confirmed the account there, and the line names the list. The line itself stays with the command
      const list = context.services.accountList;
      if (list === null) return fail("not_found", "This PC follows no list", 404);
      const { account, list: id } = body;
      if (typeof account !== "string" || typeof id !== "string") return fail("invalid_list", "Name the account and its list", 400);
      const inAccount = devices.account();
      if (inAccount !== null && inAccount !== account) return fail("in_account", "This PC is already in an account", 409);
      if (inAccount === null && context.services.relay.savedRelayAccount() !== account) return fail("account_mismatch", "This PC was set up for another account. Sign in to that one, or add this PC again.", 409);
      if (devices.listRemovedFrom(account)) return fail("list_removed", LIST_REMOVED_FROM, 409);
      const refusal = (code: string, detail?: string | null) => fail(code === "removed" ? "list_removed" : code, JOIN_REFUSALS[code] ?? `This PC could not join the account's list (${detail ?? code}).`, code === "unavailable" || code === "not_read" ? 503 : 409);
      const ended = async (outcome: JoinOutcome | { readonly again: true } | { readonly refused: string; readonly detail?: string | null }): Promise<Response> => {
        if ("again" in outcome) return reply({ state: "again" });
        if ("refused" in outcome) return refusal(outcome.refused, "detail" in outcome ? outcome.detail : null);
        if ("waiting" in outcome) return reply({ state: "waiting", standing: outcome.waiting });
        await context.services.accountMailbox.joinedByList(account);
        return reply({ state: "added", account });
      };
      // a plain invite, or the ask again after a join was placed: the PC joins once the list holds its entry
      if (pathname === "/api/account/list/join") return await ended(await list.joinList({ account, list: id, by: null }));
      const invite = body.invite;
      if (typeof invite !== "string") return fail("invalid_invite", "Name the invite by its key", 400);
      if (pathname === "/api/account/list/join/prepare") {
        const prepared = await list.joinPrepare({ account, list: id, invite });
        return "prepared" in prepared ? reply({ state: "prepared", ...prepared.prepared }) : await ended(prepared);
      }
      if (pathname === "/api/account/list/join/body") {
        const { seq, sealed } = body as { seq?: unknown; sealed?: unknown };
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return fail("invalid_join", "Name the place the join takes", 400);
        let names: Sealed | null = null;
        if (sealed !== undefined && sealed !== null) {
          const { epoch, bytes } = sealed as { epoch?: unknown; bytes?: unknown };
          const read = typeof bytes === "string" && bytes.length <= 4096 ? canonicalBase64Url(bytes) : null;
          if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0 || read === null) return fail("invalid_join", "The sealed names are an epoch and bytes", 400);
          names = { epoch, bytes: read };
        }
        const built = await list.joinBody({ account, list: id, invite, seq, sealed: names });
        return "body" in built ? reply({ state: "body", body: toBase64Url(built.body) }) : await ended(built);
      }
      const { entry, wraps } = body as { entry?: unknown; wraps?: unknown };
      const given = wraps === undefined ? [] : Array.isArray(wraps) && wraps.length <= 4 ? wraps.flatMap((wrap: unknown) => {
        const { epoch, member, wrap: text } = (typeof wrap === "object" && wrap !== null ? wrap : {}) as { epoch?: unknown; member?: unknown; wrap?: unknown };
        return typeof epoch === "number" && Number.isSafeInteger(epoch) && typeof member === "string" && typeof text === "string" && text.length <= 1024 ? [{ epoch, member, wrap: text }] : [];
      }) : null;
      if (typeof entry !== "string" || entry.length > 16_384 || given === null || (Array.isArray(wraps) && given.length !== wraps.length)) return fail("invalid_join", "Send the signed join and its wraps", 400);
      return await ended(await list.joinPlace({ account, list: id, invite, entry, wraps: given }));
    }
    case "/api/account/one-press": {
      if (!devices.opensAll()) return fail("not_found", "Unknown account action", 404);
      setRequestRoute(pathname);
      // only the PC's owner here names the account it joins: never a device through the relay (security-triage, t13r)
      if (peer.kind === "relay") return fail("owner_only", "Add this PC to your account on this PC itself.", 403);
      const account = body.account;
      if (typeof account !== "string") return fail("invalid_account", "Name the account", 400);
      const pressed = await pressOnce(context.services, account);
      notePressAsk(devices, pressed);
      return "refused" in pressed ? fail(pressed.refused.code, pressed.refused.message, pressed.refused.status) : reply(pressed);
    }
    case "/api/account/ssh-add": {
      if (!devices.opensAll()) return fail("not_found", "Unknown account action", 404);
      setRequestRoute(pathname);
      // only this PC's owner here vouches for another PC with this PC's account (dispatch.ts ownWindow refuses the rest)
      if (peer.kind === "relay") return fail("owner_only", "Add another PC to your account from this PC itself.", 403);
      // the account comes from this PC's own binding, never from the request
      const account = devices.account();
      if (account === null || devices.accountError !== null) return fail("not_in_account", "Add another PC to your account from a PC that is in it.", 409);
      const { job_id: jobId, server_id: target } = body;
      if (typeof jobId !== "string" || typeof target !== "string") return fail("invalid_body", "Name the setup job and the PC it reached", 400);
      if (target === context.services.relay.currentIdentity()?.server_id) return fail("self", "That is this PC.", 409);
      const machines = context.services.core.machines;
      if (!machines) return fail("not_found", "This PC adds no other PCs", 404);
      // that PC waits up to ADDED_RELAY_ONLINE_MS for its relay after its press: more than the default budget of an API call
      context.timeout(request, 120);
      let taken: { account: string; relay: AccountAddRelay | null; unanswered?: true };
      try { taken = await machines.accountTake(jobId, target, account); }
      catch (error) {
        if (!(error instanceof AccountAddError)) throw error;
        return fail(error.code, error.message, error.code === "job_not_found" ? 404 : 409);
      }
      // this PC left or changed its account while that PC took it: that PC is in the account named then, and says so
      if (devices.account() !== taken.account) return fail("account_changed", "This PC's account changed while the other PC was being added.", 409);
      return reply({ account: taken.account, server_id: target, relay: taken.relay, ...(taken.unanswered ? { unanswered: true as const } : {}) } satisfies AccountAddTaken);
    }
    case "/api/account/introduce": {
      setRequestRoute(pathname);
      if (peer.kind !== "relay" || !devices.isAccountApproverSession(peer.device.id, peer.key)) return fail("account_required", "Introduce devices from a device linked to the account", 403);
      if (typeof body.key !== "string" || !devices.wasAddedByMember(body.key)) return fail("introduction_unknown_key", "No account member added that device here", 404);
      const pcs = parseIntroducedPcs(body.pcs);
      if (!pcs) return fail("introduction_invalid", "List at most 32 PCs, each with a server_id its key derives", 400);
      context.services.accountIntroductions.set(body.key, pcs);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    case "/api/account/link": {
      setRequestRoute(pathname);
      // a link proves the key of the row whose session sends it, and only the relay carries a row's key
      if (peer.kind !== "relay") return fail("link_not_owner", "Link a device from its own connection through the relay", 403);
      // what stood when the link arrived, before its signature is checked: its checks are held to it. A row that
      // waits to link sends five links, whatever each is answered; the next turned it away
      const arrival = devices.linkArrived(peer.device.id, peer.device.provisional === true);
      if (arrival === null) return fail("link_required", "The link was refused: link_required", LINK_STATUS.link_required);
      // a link that may bring this PC into an account: account adds wait until its member enrolls it. On disk
      // first, so a stop keeps them waiting; never lifted by a refused link, as another may be on its way
      // (with no account here no add applies anyway, and the next first member takes the barrier over)
      if (context.services.accountHolds.error !== null) return fail("account_unavailable", context.services.accountHolds.error, 503);
      const first = devices.account() === null;
      // a barrier confirmed by a member who has since left (the PC has no account again) is this link's to take over.
      // Nothing of a device that waits to link is written before its link has passed every check: its barrier goes to
      // disk in the turn that writes its row, before it (applyLink). So one whose link is refused, or outlives its
      // time, leaves none
      if (first && !arrival.provisional) context.services.accountHolds.startEnrolling(peer.device.id, { stale: true });
      const linked = await applyLink(devices, body.record, { deviceId: peer.device.id, serverId: peer.serverId, sessionKey: peer.key, sessionId: peer.sessionId }, arrival, {
        gates: context.services.accountMailbox.gates(),
        barrier: () => context.services.accountHolds.startEnrollingBeforeRow(peer.device.id),
        setUpFor: () => context.services.relay.savedRelayAccount(),
        vouch: (account, key, firstLink) => context.services.accountMailbox.vouch(account, key, firstLink),
      });
      if ("refused" in linked) {
        const refused = fail(linked.refused, linked.message ?? `The link was refused: ${linked.refused}`, LINK_STATUS[linked.refused]);
        // when the PC may ask the account service again: the device sends the same link after it
        if (linked.retryAfter !== undefined) refused.headers.set("retry-after", String(linked.retryAfter));
        return refused;
      }
      // the wait is this device's to end: a link refused meanwhile may have named another; the first link that succeeds keeps it
      if (first) context.services.accountHolds.confirmEnrolling(peer.device.id);
      return reply({ device: linked.device });
    }
    case "/api/account/records": {
      setRequestRoute(pathname);
      const records = body.records;
      if (!Array.isArray(records) || records.length > ACCOUNT_RECORDS_MAX) return fail("record_invalid", `Send at most ${ACCOUNT_RECORDS_MAX} records`, 400);
      const mailbox = context.services.accountMailbox;
      // with the release flag on a block applies at once, each with its own receipt (T51, T60); an app that sends none
      // gets today's answer
      const blocks = context.services.safetyLog === null ? [] : records.filter((record) => (record as { kind?: unknown } | null)?.kind === "block");
      const wasMember = blocks.length > 0 && peer.kind === "relay" && devices.isAccountApproverSession(peer.device.id, peer.key);
      const receipts = [];
      for (const block of blocks) receipts.push(await devices.applyBlock(block, "handed"));
      const gates = { ...mailbox.gates(), safetyLog: context.services.safetyLog, deferAdd: devices.opensAll() ? (record: unknown) => mailbox.wait(record) : undefined,
        requestRead: devices.opensAll() ? () => { void mailbox.readSnapshot(); } : undefined };
      const remaining = records.filter((record) => !blocks.includes(record));
      // Only a current member's session may leave a removal waiting. A session blocked in this batch may do neither that nor apply any other record.
      const member = peer.kind === "relay" && devices.isAccountApproverSession(peer.device.id, peer.key);
      const results = wasMember && !member
        ? remaining.map((record: unknown) => ({
          id: typeof record === "object" && record !== null && "id" in record && typeof record.id === "string" ? record.id : null,
          outcome: "refused", code: "account_required",
        }))
        : await applyAccountRecords(devices, remaining, serverId, Date.now(), gates, member ? (record) => mailbox.wait(record) : undefined);
      return reply({ results, ...(blocks.length > 0 ? { receipts } : {}) });
    }
    case "/api/account/enroll": {
      setRequestRoute(pathname);
      const { records, held, held_full: heldFull, last } = body;
      if (!Array.isArray(records) || records.length > ACCOUNT_ENROLL_MAX) return fail("record_invalid", `Send at most ${ACCOUNT_ENROLL_MAX} records`, 400);
      if ((last !== undefined && typeof last !== "boolean") || (heldFull !== undefined && typeof heldFull !== "boolean")) return fail("record_invalid", "last and held_full are true or false", 400);
      if (held !== undefined && (!Array.isArray(held) || held.length > ACCOUNT_HELD_MAX || !held.every(isAccountKeyEncoding))) return fail("record_invalid", `Hold at most ${ACCOUNT_HELD_MAX} account keys`, 400);
      // what a member hands a PC it brought into the account: the caller is a member of that account here already
      if (peer.kind !== "relay" || !devices.isAccountApproverSession(peer.device.id, peer.key) || typeof body.account !== "string" || devices.account() !== body.account) {
        return fail("account_required", "Link this device to the account on this PC first", 403);
      }
      const holds = context.services.accountHolds;
      const mailbox = context.services.accountMailbox;
      if (holds.error !== null) return fail("account_unavailable", holds.error, 503);
      // before any add, and before the barrier lifts: the keys the member found removed elsewhere stay out of every path
      holds.hold(held ?? []);
      // more keys than one enrollment carries: every add is held back from now on, rather than one let in by the cut
      if (heldFull === true) holds.overflow();
      const gates = mailbox.gates();
      // only the member whose link brought this PC in hands over its adds during the wait; another member's wait with the mailbox's
      // the member whose link brought this PC in, or any member once that one is no longer a drive member here (revoked, say)
      const named = holds.enrollingMember();
      const linker = named === peer.device.id || (named !== null && !devices.isAccountApprover(named));
      const results = await applyEnrollment(devices, records, serverId, { gates: { enrolling: () => !linker && holds.enrolling(), held: gates.held, ...(gates.removing ? { removing: gates.removing } : {}) }, wait: (record) => mailbox.wait(record), settle: () => mailbox.settle() });
      // only the member that linked this PC ends its wait, with the last part of its enrollment, once every remove was decided
      const undecided = results.some((result) => result.outcome === "refused" && result.code === "account_unavailable");
      if (last !== false && !undecided && linker) {
        // the hand-over is journalled before the barrier ends: a journal that cannot be written keeps it (T14)
        devices.journalEvent({ kind: "account", how: "enrolled", key: peer.key, no: null, row: peer.device.id, label: peer.device.label, by: null, account: body.account });
        holds.endEnrolling();
        await mailbox.settle();
      }
      return reply({ results });
    }
    default: return fail("not_found", "Unknown account action", 404);
  }
}
