import { accountDeviceId, newRecordId, signAccountRecord } from "../../../shared/account-records.ts";
import { decodeOffer } from "../../../shared/relay-offer.ts";
import type { PairedDevice } from "../../../shared/protocol.ts";
import { errorFrom } from "../api.ts";
import { indexedDeviceStore } from "../relay/device.ts";
import { deviceLabel } from "../phone.ts";
import { accountDevice } from "./accountDevice.ts";
import { AddPcWaitOver, directoryEntry } from "./addThisPc.ts";
import { AccountPcError, enrollPc, planEnroll, post } from "./join.ts";
import { pcAccountServiceOf, sameSignIn, type AccountService } from "./service.ts";
import { indexedAccountStore, type AccountSession } from "./store.ts";
import { forgedOffer, offerOf } from "../relay/shellState.ts";
import { openRelayTransport } from "../relay/transport.ts";
import { PEER_STATUS_MS } from "./join.ts";

/** Deliberately not the selected PC transport: a window's bearer never goes through a relay, a machine proxy or a redirect. */
const local = (path: string, init?: RequestInit) => fetch(path, { ...init, mode: "same-origin", redirect: "error", cache: "no-store" });
/** Only a received HTTP refusal becomes an ApiError; an invalid or missing success reply is not a refusal. */
const checkedLocal = async (path: string, init?: RequestInit) => {
  const response = await local(path, init);
  if (!response.ok) throw await errorFrom(path, response);
  return response;
};
export interface FirstEnrollment { readonly account: string; finish(): Promise<void> }
export interface FirstClaim { readonly serverId: string; readonly id: string }

/** The legacy listing needs an explicit null, not a missing field; reconciliation needs an explicit false. */
export async function firstMemberMembership() {
  const status: { account?: unknown; enrolling?: unknown } = await (await checkedLocal("/api/account/status")).json();
  if (status.account !== null && typeof status.account !== "string") throw new AccountPcError(502, "status_invalid");
  return { account: status.account, enrolling: typeof status.enrolling === "boolean" ? status.enrolling : undefined };
}

export async function firstMember(service: AccountService, session: AccountSession, running: () => boolean,
  attempt: { sent: (claim: FirstClaim) => void } | { recover: FirstClaim }): Promise<FirstEnrollment> {
  if (session.service !== pcAccountServiceOf(document, window.isSecureContext)) throw new AccountPcError(409, "account_mismatch");
  const account = session.account;
  const own = async () => {
    const now = await service.session();
    if (!now || !sameSignIn(session, now) || now.account !== account) throw new AddPcWaitOver("sign-in");
    if (!running()) throw new AddPcWaitOver("ended");
  };
  const label = deviceLabel(navigator.userAgent, navigator.maxTouchPoints);
  const base = "/api/account/first-member";
  await own();
  if ("recover" in attempt) {
    const { serverId, id } = attempt.recover;
    const status = await firstMemberMembership();
    // A read that outlives its retry must not replace a newer attempt's challenge.
    if (!running()) throw new AddPcWaitOver("ended");
    if (status.account === null) throw new AccountPcError(409, "claim_not_applied");
    if (status.account !== account) throw new AddPcWaitOver("sign-in");
    if (status.enrolling !== true) {
      if (status.enrolling !== false) throw new AccountPcError(409, "account_unavailable");
      // The final enroll may have committed before its acknowledgment was lost. Account identity alone isn't proof.
      const { public_spki: key } = await indexedAccountStore.key();
      const { devices }: { devices: PairedDevice[] } = await (await checkedLocal("/api/devices")).json();
      if (accountDeviceId(serverId, key) !== id || !devices.some(row => row.id === id && row.account === account && row.account_key === key && row.role === "drive")) {
        throw new AccountPcError(403, "account_required");
      }
      return { account, async finish() {
        await own();
        let owned = false;
        await indexedAccountStore.updateMany(["session", "leaving", "enrolls"], current => {
          owned = running() && current.session !== undefined && sameSignIn(current.session, session) && current.session.account === account && !Object.values(current.leaving ?? {}).includes(key);
          if (!owned || current.enrolls?.[serverId]?.account !== account) return current;
          const { [serverId]: _finished, ...rest } = current.enrolls;
          return { ...current, enrolls: Object.keys(rest).length ? rest : undefined };
        });
        if (!owned) throw new AddPcWaitOver("sign-in");
      } };
    }
  }
  const { challenge } = await (await post(checkedLocal, base + "/challenge", { label })).json();
  if (typeof challenge !== "string" || !/^[0-9a-f]{32}$/.test(challenge)) throw new AccountPcError(400, "challenge_invalid");
  const response = await checkedLocal("/api/relay/link");
  const offer = decodeOffer((await response.json()).url);
  if (!offer || offer.code || forgedOffer(offer)) throw new AccountPcError(400, "record_invalid");
  const key = await indexedAccountStore.key();
  const device = { ...accountDevice(offer, key), label, account };
  const serverId = offer.server_id;
  const id = accountDeviceId(serverId, key.public_spki);
  if ("recover" in attempt && (attempt.recover.serverId !== serverId || attempt.recover.id !== id)) throw new AddPcWaitOver("pc");
  const record = await signAccountRecord({ v: 1, kind: "link", account, key: key.public_spki, signer: key.public_spki, old_key: key.public_spki,
    server_id: serverId, device_id: id, issued_at: new Date().toISOString(), id: challenge }, key.private_key);
  await own();
  // Same transaction as leaveAccount's snapshot: a concurrent leave names an in-flight first link,
  // and a leave that got there first sends no claim.
  const link = newRecordId();
  let reserved = false;
  await indexedAccountStore.updateMany(["session", "leaving", "linking"], current => {
    reserved = current.session !== undefined && sameSignIn(current.session, session) && !Object.values(current.leaving ?? {}).includes(key.public_spki);
    return reserved ? { ...current, linking: { ...current.linking, [link]: serverId } } : current;
  });
  if (!reserved) throw new AddPcWaitOver("sign-in");
  if ("sent" in attempt) attempt.sent({ serverId, id });
  const admitted = await post(checkedLocal, base, { account, record, token: session.access_token, ...("recover" in attempt ? { recover: true } : {}) }).finally(() =>
    indexedAccountStore.update("linking", current => {
      const { [link]: _ended, ...rest } = current ?? {};
      return Object.keys(rest).length ? rest : undefined;
    }));
  const grant = admitted.headers.get("x-ovis-first-enroll");
  const row = (await admitted.json()).device;
  if (!grant || row?.id !== id || row.role !== "drive") throw new AccountPcError(403, "account_required");
  const directory = service.forSignIn(session);
  return { account, async finish() {
    await own();
    // Keep the pairing and enrollment plan before touching the directory: the usual member can resume them over AUTH.
    await indexedDeviceStore.update(serverId, current => {
      if (current && current.server_public_key !== offer.server_public_key) throw new AddPcWaitOver("pc");
      return device;
    });
    if (!(await indexedAccountStore.get("enrolls"))?.[serverId]) await planEnroll(indexedAccountStore, serverId, account);
    await directory.putPc(serverId, directoryEntry(offer));
    const others = (await directory.listPcs()).filter(pc => pc.server_id !== serverId);
    const paired = (await indexedDeviceStore.list()).filter(pc => pc.server_id !== serverId && pc.device_id !== null && pc.account === account && pc.public_spki === key.public_spki);
    const peers = paired.map(peer => ({ serverId: peer.server_id, fetch: async (path: string, init?: RequestInit) => {
      await own();
      const signal = AbortSignal.timeout(PEER_STATUS_MS);
      const transport = await openRelayTransport(offerOf(peer), { signal });
      try { return await transport.fetch(path, { ...init, signal }).then(async res => new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers })); }
      finally { transport.close(); }
    } }));
    const result = await enrollPc({ store: indexedAccountStore, account, serverId, listed: others.length, others: peers,
      pc: { ...offer, name: directoryEntry(offer).label }, fetch: async (path, init) => {
      await own();
      if (path !== "/api/account/enroll") throw new AccountPcError(403, "account_required");
      const headers = new Headers(init?.headers);
      headers.set("x-ovis-first-enroll", grant);
      return local(path, { ...init, headers });
    } });
    if (!result.finished) throw new AccountPcError(409, "enrolling");
  } };
}
