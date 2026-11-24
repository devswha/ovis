import { describe, expect, it } from "bun:test";
import { listView } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { inviteMakeBytes } from "../../../shared/account-list-invite.ts";
import { JOIN_LINE_PREFIX, readJoinLine } from "../../../shared/account-list-join.ts";
import { fromBase64Url } from "../../../shared/relay-pair-sas.ts";
import { listWorld, type WorldDevice } from "./accountList.test-helpers.ts";
import { INVITE_S, invitesOf, makeInvite, revokeInvite, type MadeInvite } from "./listInvite.ts";

type World = ReturnType<typeof listWorld>;

const noWait = { wait: async () => {} };
const MINUTE = 60_000;
const routes = (from: WorldDevice): string[] => from.sent.map((each) => each.route);
const placements = (from: WorldDevice) => from.sent.filter((each) => each.route.endsWith("/entries"));
const kinds = (texts: readonly string[]): string[] => texts.map((text) => readBody(entryFromText(text).body).kind);
const made = (outcome: Awaited<ReturnType<typeof makeInvite>>): MadeInvite => {
  if (!outcome.made) throw new Error(`no invite was made: ${outcome.why}${outcome.code === undefined ? "" : ` ${outcome.code}`}`);
  return outcome.invite;
};

/** An account whose first device started its list. */
async function oneDevice(w: World = listWorld(), skew = 0): Promise<{ w: World; first: WorldDevice }> {
  const first = await w.device({ label: "Dana's phone", skew });
  await first.list.sync();
  expect(first.list.writer()).not.toBeNull();
  return { w, first };
}

describe("a device that is in the list makes an invite", () => {
  it("gives the account service the public key alone, places an `invite` entry for one use that ends within fifteen minutes, and only then has the line", async () => {
    const { w, first } = await oneDevice();
    const before = first.sent.length;
    const invite = made(await makeInvite(first.list, { auto: false, ...noWait }));
    // the line is the list's join line, for this service, account and list, and its key is the entry's
    expect(invite.line.startsWith(JOIN_LINE_PREFIX)).toBe(true);
    const line = await readJoinLine(invite.line, { service: w.origin, followsLists: true });
    expect([line.account, line.list, line.key]).toEqual([w.account, w.held().id, invite.key]);
    // the account service's invite first, then the entry; neither request carries anything of the line but the public key
    const sent = first.sent.slice(before);
    const routesSent = sent.map((each) => each.route);
    expect(routesSent.indexOf("POST /v1/pc-invites")).toBeGreaterThanOrEqual(0);
    expect(routesSent.indexOf("POST /v1/pc-invites")).toBeLessThan(routesSent.indexOf(`POST /v2/lists/${w.held().id}/entries`));
    expect(sent.find((each) => each.route === "POST /v1/pc-invites")!.body).toEqual({ invite_key: invite.key, auto: false });
    expect(JSON.stringify(sent)).not.toContain(invite.line.slice(JOIN_LINE_PREFIX.length));
    // the entry: one use, not for a machine by itself, over within fifteen minutes of this device's own clock
    const now = Math.floor(w.clock.now / 1000);
    expect(listView(w.held().state).invites.map((row) => [row.key, row.uses, row.joins, row.auto, row.refusal])).toEqual([[invite.key, 1, 0, false, null]]);
    expect(invite.exp).toBe(now + INVITE_S);
    expect(INVITE_S).toBeLessThan(15 * 60);
    expect(listView(w.held().state).invites[0]!.exp).toBe(invite.exp);
    // a plain invite holds no key of the list: nothing is wrapped to it
    expect(placements(first).at(-1)!.body!.wraps).toBeUndefined();
    // and this device lists it as open
    expect(invitesOf(first.list, w.clock.now).map((row) => [row.key, row.state, row.auto, row.exp])).toEqual([[invite.key, "open", false, invite.exp]]);
  });

  it("wraps the epoch key to an invite a machine joins with by itself", async () => {
    const { w, first } = await oneDevice();
    const invite = made(await makeInvite(first.list, { auto: true, ...noWait }));
    expect(first.sent.find((each) => each.route === "POST /v1/pc-invites")!.body).toEqual({ invite_key: invite.key, auto: true });
    expect(listView(w.held().state).invites.map((row) => [row.key, row.uses, row.auto])).toEqual([[invite.key, 1, true]]);
    expect((placements(first).at(-1)!.body!.wraps as { member: string; epoch: number }[]).map((wrap) => [wrap.member, wrap.epoch])).toEqual([[invite.key, 0]]);
  });

  it("proves its registered key for that very invite once its sign-in is old, to the account service's invite and to the entry alike", async () => {
    const { w, first } = await oneDevice();
    w.clock.now += 11 * MINUTE;
    const registered = (await first.store.get("signin_key"))!.key.public_spki;
    const challenges = new Map<string, string>();
    const proofs: boolean[] = [];
    // the fake holds no challenge for the invite route: this answers that route as the account service does, checking the proof
    first.wire.answer = async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/pcs/challenge") {
        const answer = await w.fake.fetch(request.clone());
        const issued = await answer.clone().json() as { challenge_id: string; challenge: string };
        challenges.set(issued.challenge_id, issued.challenge);
        return answer;
      }
      if (path !== "/v1/pc-invites" || request.method !== "POST") return null;
      const body = await request.json() as { invite_key: string; auto: boolean; key_proof?: { challenge_id: string; signature: string } };
      const challenge = body.key_proof === undefined ? undefined : challenges.get(body.key_proof.challenge_id);
      if (body.key_proof === undefined || challenge === undefined) return Response.json({ error: { code: "session_not_fresh", message: "Sign in again on this device first" } }, { status: 403 });
      const key = await crypto.subtle.importKey("spki", new Uint8Array(fromBase64Url(registered)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const bytes = inviteMakeBytes({ account: w.account, invite_key: body.invite_key, auto: body.auto, challenge_id: body.key_proof.challenge_id, challenge });
      proofs.push(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(fromBase64Url(body.key_proof.signature)), bytes));
      return Response.json({ id: "ab".repeat(16), account: w.account, expires_at: new Date(w.clock.now + 15 * MINUTE).toISOString(), auto: body.auto });
    };
    const invite = made(await makeInvite(first.list, { auto: false, ...noWait }));
    expect(proofs).toEqual([true]);
    // the entry is placed with a proof of its own, which the account service checked
    expect(placements(first).at(-1)!.body!.key_proof).toBeDefined();
    expect(listView(w.held().state).invites.map((row) => row.key)).toEqual([invite.key]);
  });

  it("shows no line where the account service made no invite, and signs nothing", async () => {
    const { w, first } = await oneDevice();
    first.wire.answer = (request) => new URL(request.url).pathname === "/v1/pc-invites" ? Response.json({ error: { code: "invites_full", message: "Revoke an open invite first" } }, { status: 409 }) : null;
    const entries = w.held().entries.length;
    expect(await makeInvite(first.list, { auto: false, ...noWait })).toEqual({ made: false, why: "service", code: "invites_full", retryAfterMs: null });
    expect(w.held().entries.length).toBe(entries);
    expect(placements(first).filter((each) => kinds(each.body!.entries as string[]).includes("invite"))).toEqual([]);
  });

  it("shows no line where the account service names another account for the invite", async () => {
    const { w, first } = await oneDevice();
    first.wire.answer = (request) => new URL(request.url).pathname === "/v1/pc-invites" && request.method === "POST"
      ? Response.json({ id: "cd".repeat(16), account: "acct_other", expires_at: new Date(w.clock.now + 15 * MINUTE).toISOString(), auto: false }) : null;
    const entries = w.held().entries.length;
    expect(await makeInvite(first.list, { auto: false, ...noWait })).toMatchObject({ made: false, why: "service", code: "invalid_answer" });
    expect(w.held().entries.length).toBe(entries);
  });

  it("shows no line where the list did not take the entry, and ends the account service's invite it made", async () => {
    const { w, first } = await oneDevice();
    first.wire.answer = (request) => new URL(request.url).pathname.endsWith("/entries") ? Response.json({ error: { code: "list_stopped", message: "The list cannot be changed" } }, { status: 503 }) : null;
    expect(await makeInvite(first.list, { auto: false, ...noWait })).toMatchObject({ made: false, why: "stopped" });
    expect(routes(first).filter((route) => route.startsWith("DELETE /v1/pc-invites/"))).toHaveLength(1);
    expect(invitesOf(first.list, w.clock.now)).toEqual([]);
  });

  it("makes none on a device that may not write the list", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const second = await w.device({ label: "Dana's tablet" });
    await second.list.sync();
    expect(await makeInvite(second.list, { auto: false, ...noWait })).toMatchObject({ made: false, why: "no_list" });
    expect(routes(second)).not.toContain("POST /v1/pc-invites");
  });
});

describe("the invites of a list, as a device shows them", () => {
  it("calls an invite past its time expired, by this device's own clock, and never open", async () => {
    const { first } = await oneDevice();
    const invite = made(await makeInvite(first.list, { auto: false, ...noWait }));
    expect(invitesOf(first.list, (invite.exp - 1) * 1000).map((row) => row.state)).toEqual(["open"]);
    expect(invitesOf(first.list, (invite.exp + 1) * 1000).map((row) => row.state)).toEqual(["expired"]);
  });

  it("revokes an invite by a `remove` of its key, and an invite a machine joins with by itself with the next epoch after it", async () => {
    const { w, first } = await oneDevice();
    const plain = made(await makeInvite(first.list, { auto: false, ...noWait }));
    expect(await revokeInvite(first.list, plain.key, noWait)).toEqual({ revoked: true });
    expect(kinds(placements(first).at(-1)!.body!.entries as string[])).toEqual(["remove"]);
    expect(invitesOf(first.list, w.clock.now).map((row) => [row.key, row.state])).toEqual([[plain.key, "revoked"]]);
    // the account service's invite goes too, where this device made it
    expect(routes(first).filter((route) => route.startsWith("DELETE /v1/pc-invites/"))).toHaveLength(1);
    const auto = made(await makeInvite(first.list, { auto: true, ...noWait }));
    expect(await revokeInvite(first.list, auto.key, noWait)).toEqual({ revoked: true });
    expect(kinds(placements(first).at(-1)!.body!.entries as string[])).toEqual(["remove", "epoch"]);
    expect(w.held().state.epoch).toBe(1);
    // an invite that is out already: nothing more is signed
    const placed = placements(first).length;
    expect(await revokeInvite(first.list, auto.key, noWait)).toEqual({ revoked: true });
    expect(placements(first).length).toBe(placed);
  });
});
