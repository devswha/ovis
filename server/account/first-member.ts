import { AccountRecordError, accountDeviceId, isIsoTime, newRecordId, readAccountRecord } from "../../shared/account-records.ts";
import type { DeviceStore } from "../devices.ts";
import type { RequestServices } from "../dispatch.ts";
import { isJsonObject, jsonResponse } from "../http.ts";
import { accountServiceUrl } from "./mailbox.ts";

export const FIRST_MEMBER = "/api/account/first-member";
export const FIRST_CHALLENGE = `${FIRST_MEMBER}/challenge`;

/** A challenge can lead to a new row only on an empty PC; on an enrolling PC it can only replace a grant. */
export function firstMemberSlot({ devices, accountHolds }: RequestServices) {
  const rows = devices.list(null, true);
  const account = devices.account();
  if (account === null && rows.length === 0) return "empty";
  const row = rows[0];
  if (rows.length === 1 && row && account !== null && row.account === account && row.account_key &&
    row.id === accountHolds.enrollingMember() && devices.isAccountApproverSession(row.id, row.account_key)) return row;
  return "occupied";
}

/** One pending challenge per PC, never shared between server instances or kept over restart. */
const pending = new WeakMap<DeviceStore, { nonce: string; label: string; until: number; used: boolean }>();
const watching = new WeakSet<DeviceStore>();

export function firstChallenge(devices: DeviceStore, label: unknown): string {
  const nonce = newRecordId();
  if (!watching.has(devices)) {
    watching.add(devices);
    devices.onRevokeAll(() => { pending.delete(devices); enrollment.delete(devices); });
  }
  pending.set(devices, { nonce, label: typeof label === "string" ? label.slice(0, 48) : "Device", until: Date.now() + 60_000, used: false });
  return nonce;
}

function takeFirstChallenge(devices: DeviceStore, nonce: unknown) {
  const issued = pending.get(devices);
  if (!issued || issued.used || issued.nonce !== nonce) return null;
  issued.used = true;
  return Date.now() < issued.until ? issued : null;
}

const enrollment = new WeakMap<DeviceStore, { secret: string; account: string; id: string; key: string; until: number }>();

/** This capability is only returned to the window that submitted the proof. Never a relay credential. */
export function localEnroller(services: RequestServices, secret: string | null) {
  const held = enrollment.get(services.devices);
  if (!held || secret !== held.secret || Date.now() >= held.until || services.accountHolds.enrollingMember() !== held.id) return null;
  const device = services.devices.accountSigner(held.key, held.account);
  return device?.id === held.id ? { device, key: held.key } : null;
}

async function provesOwnSignIn(services: RequestServices, account: string, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(token)) return false;
  const service = services.options.accountService;
  try {
    const response = await (service?.fetch ?? fetch)(new Request(accountServiceUrl(service?.url) + "/v1/session", {
      headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(8000), cache: "no-store",
    }));
    if (!response.ok) return false;
    const proof: unknown = await response.json();
    if (!isJsonObject(proof) || proof.account !== account || proof.own_sign_in !== true || !isIsoTime(proof.signed_in_at)) return false;
    // a minute of clock difference between this PC and the account service either way, as a laptop just woken can have
    const age = Date.now() - Date.parse(proof.signed_in_at);
    return age >= -60_000 && age <= 600_000;
  } catch {
    // The upstream error may carry the credential. Nothing from it is returned, logged or retried.
    return false;
  }
}

export async function claimFirstMember(services: RequestServices, body: Record<string, unknown>): Promise<Response> {
  const { devices, accountHolds: holds, accountMailbox: mailbox, relay } = services;
  const fail = (status: number, code: string) => jsonResponse({ error: { code, message: "This PC could not add its first member." } }, status, { "cache-control": "no-store" });
  const before = firstMemberSlot(services);
  const issued = takeFirstChallenge(devices, isJsonObject(body.record) ? body.record.id : null);
  if (issued === null) return fail(409, before === "empty" ? "challenge_invalid" : "in_account");
  let record;
  try { record = await readAccountRecord(body.record); } catch (error) {
    if (!(error instanceof AccountRecordError)) throw error;
    return fail(400, "record_invalid");
  }
  if (record?.kind !== "link" || record.account !== body.account || record.key !== record.old_key
    || record.server_id !== relay.currentIdentity()?.server_id || record.device_id !== accountDeviceId(record.server_id, record.key)) return fail(400, "record_invalid");
  const { key, account, device_id: id } = record;
  const matches = (slot: ReturnType<typeof firstMemberSlot>) => typeof slot !== "string" && slot.account === account && slot.id === id && slot.account_key === key;
  if (before === "empty" ? body.recover === true : !matches(before)) return fail(409, "in_account");
  if (!await provesOwnSignIn(services, account, body.token)) return fail(403, "own_sign_in_required");
  // Repeat the PC checks in the synchronous commit turn: a pairing, identity reset or removal may have won the read.
  const slot = firstMemberSlot(services);
  if (before === "empty" ? slot !== "empty" : !matches(slot)) return fail(409, "in_account");
  if (pending.get(devices) !== issued || Date.now() >= issued.until) return fail(409, "challenge_invalid");
  if (relay.currentIdentity()?.server_id !== record.server_id || devices.error || devices.accountError || devices.isTombstoned(key)
    || holds.error || mailbox.gates().held(key) || (relay.savedRelayAccount() !== null && relay.savedRelayAccount() !== account)) return fail(409, "account_unavailable");
  let device;
  if (slot === "empty") {
    const undo = holds.startEnrollingBeforeRow(id);
    try { device = devices.enrollFirstMember({ id, key, account, label: issued.label }); }
    finally { if (!devices.isAccountApproverSession(id, key)) undo(); }
    if (!device) return fail(409, "account_unavailable");
    holds.confirmEnrolling(id);
  } else {
    device = devices.accountSigner(key, account);
    if (device?.id !== id) return fail(409, "in_account");
  }
  const secret = newRecordId();
  const watched = enrollment.get(devices)?.id === id;
  enrollment.set(devices, { secret, id, key, account, until: Date.now() + 600_000 });
  if (!watched) devices.onRevoke(id, () => enrollment.delete(devices));
  return jsonResponse({ device }, 200, { "cache-control": "no-store", "x-ovis-first-enroll": secret });
}
