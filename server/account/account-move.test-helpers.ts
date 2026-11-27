import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { newInvite } from "../../shared/account-list-join.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { createServer } from "../index.ts";
import { pressInto } from "./listed-pc.test-helpers.ts";
import { memberRow, pairingPc, type Pc } from "./pairing.test-helpers.ts";

export const FROM = "acct_before";
export const INTO = "acct_after";
export const MERGE = `mrg_${"a".repeat(22)}`;
export const LISTING = "a".repeat(32);
export const JOURNAL = "account-move.json";
export const ACCOUNT_SERVICE = "https://account.test";
export const HEADERS = { "x-herdr-machine": "1" };
export const MOVE = "/api/account/move";

export const filesOf = (stateDir: string, files: readonly string[]) => files.map(file => readFileSync(join(stateDir, file), "utf8"));

export async function movePc(options: Parameters<typeof pairingPc>[0] & { memberAge?: number; bound?: boolean } = {}) {
  const member = await memberRow(FROM);
  if (options.memberAge !== undefined) member.row.created_at = new Date(Date.now() - options.memberAge).toISOString();
  const pc = await pairingPc({
    ...options, rows: options.memberAge === undefined ? options.rows : [member.row],
    server: { accountOpensAll: true, ...options.server },
  });
  try {
    const { services } = pc.app.context;
    if (options.memberAge === undefined && options.bound !== false) await pressInto(pc.account, services, FROM);
    else if (options.memberAge !== undefined) {
      pc.account.opensAll = true;
      await listForPress(pc, FROM);
      expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    }
    const { key, line } = await newInvite(ACCOUNT_SERVICE, INTO, null);
    const body = { from: FROM, into: INTO, merge_id: MERGE, invite: line };
    pc.account.openMerge({ ...body, invite_key: key });
    return { pc, services, member, body,
      order: (change: Partial<typeof body> = {}) => pc.local(MOVE, { method: "POST", headers: HEADERS, body: { ...body, ...change } }) };
  } catch (error) {
    await pc.close();
    throw error;
  }
}

export async function listForPress(pc: Pc, account: string) {
  const identity = pc.app.context.services.relay.currentIdentity();
  if (!identity) throw new Error("The test PC has no relay identity");
  const headers = { authorization: `Bearer ${pc.account.issueToken(account, { twoStep: true })}` };
  const url = `${ACCOUNT_SERVICE}/v1/pcs/${identity.server_id}`;
  const listed = await pc.account.fetch(new Request(url, { method: "PUT", headers, body: JSON.stringify({
    label: "Desk", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.test",
  }) }));
  expect(listed.status).toBe(200);
  expect((await pc.account.fetch(new Request(`${url}/admit`, { method: "POST", headers, body: "{}" }))).status).toBe(200);
}

export function reopen(pc: Pc, options: Parameters<typeof createServer>[0] = {}) {
  return createServer({
    stateDir: pc.stateDir, port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, sidecar: false,
    accountOpensAll: true, accountService: { url: ACCOUNT_SERVICE, fetch: pc.account.fetch }, ...options,
  });
}
