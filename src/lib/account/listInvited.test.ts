import { describe, expect, it } from "bun:test";
import { signCard } from "../../../shared/account-list.ts";
import { readJoinLine } from "../../../shared/account-list-join.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { askingPc, listWorld, postPcKeys, type AskingPc, type WorldDevice } from "./accountList.test-helpers.ts";
import type { ListPost } from "./listAnswers.ts";
import { lineChallenge } from "../../../shared/account-list-invite.ts";
import { addInvitedPc, invitedPcs } from "./listInvited.ts";
import { makeInvite, revokeInvite, type MadeInvite } from "./listInvite.ts";

type World = ReturnType<typeof listWorld>;
const noWait = { wait: async () => {} };

/** A device that is in its list and made an invite that waits for Add, and a PC that holds the line. */
async function invited(auto = false) {
  const w = listWorld();
  const first = await w.device({ label: "Dana's Mac" });
  await first.list.sync();
  const made = await makeInvite(first.list, { auto, ...noWait });
  if (!made.made) throw new Error(`no invite was made: ${made.why}`);
  const pc = await askingPc();
  return { w, first, invite: made.invite, pc };
}

/** The PC's post as it reaches the device: its card for the list, and the line's proof that whoever holds the line named this very card. */
async function posted(w: World, first: WorldDevice, invite: MadeInvite, pc: AskingPc, more: { signedFor?: AskingPc } = {}): Promise<ListPost> {
  const list = first.list.writer()!.list;
  const card = await signCard({ key: pc.key, enc: pc.enc, list, endpoint: pc.endpoint, invite: null }, pc.signs);
  const line = await readJoinLine(invite.line, { service: w.origin, followsLists: true });
  const named = more.signedFor ?? pc;
  const proof = await line.signLineProof({ server_id: named.server_id, card: { key: named.key, enc: named.enc, endpoint: named.endpoint } });
  return { endpoint: pc.endpoint, server_id: pc.server_id, key: pc.key, enc: pc.enc, card, attempt: null, invite: invite.key, invite_proof: proof };
}

describe("a PC that joined with an invite a device of the account made", () => {
  it("is offered for Add only where the line itself signed for that PC's card, for an invite the list holds open that waits for Add", async () => {
    const { w, first, invite, pc } = await invited();
    const post = await posted(w, first, invite, pc);
    expect((await invitedPcs(first.list, [post], w.clock.now)).map((each) => [each.endpoint, each.invite, each.by])).toEqual([[pc.endpoint, invite.key, (await first.keys()).key]]);
  });

  it("is not offered on the account service's word: a post with no proof, another PC's proof, or a proof for another list", async () => {
    const { w, first, invite, pc } = await invited();
    const other = await askingPc();
    const good = await posted(w, first, invite, pc);
    const { invite: _key, invite_proof: _proof, ...bare } = good;
    for (const post of [
      bare,
      // the line signed for another PC, and the service shows that proof beside this PC's card
      await posted(w, first, invite, pc, { signedFor: other }),
      { ...good, invite_proof: "A".repeat(86) },
      // a key that is no invite of the list
      { ...good, invite: (await first.keys()).key },
    ] as ListPost[]) {
      expect(await invitedPcs(first.list, [post], w.clock.now)).toEqual([]);
    }
  });

  it("is not offered on a redeem signature of the line: a lying account service chooses the challenge of a redeem, so it could have the line sign the challenge of a card of its own", async () => {
    const { w, first, invite, pc } = await invited();
    const list = first.list.writer()!.list;
    // the service's own keys, under the PC's real relay key and id
    const service = await askingPc();
    const card = await signCard({ key: service.key, enc: service.enc, list, endpoint: pc.endpoint, invite: null }, service.signs);
    const line = await readJoinLine(invite.line, { service: w.origin, followsLists: true });
    const redeemed = await line.signRedeem({ server_id: pc.server_id, public_key: pc.endpoint, challenge_id: lineChallenge(list, { key: service.key, enc: service.enc, endpoint: pc.endpoint }) });
    const lie: ListPost = { endpoint: pc.endpoint, server_id: pc.server_id, key: service.key, enc: service.enc, card, attempt: null, invite: invite.key, invite_proof: redeemed };
    expect(await invitedPcs(first.list, [lie], w.clock.now)).toEqual([]);
  });

  it("is not offered for an invite that is over, was revoked, or lets a PC join by itself", async () => {
    const { w, first, invite, pc } = await invited();
    const post = await posted(w, first, invite, pc);
    expect(await invitedPcs(first.list, [post], (invite.exp + 1) * 1000)).toEqual([]);
    expect(await revokeInvite(first.list, invite.key, noWait)).toEqual({ revoked: true });
    expect(await invitedPcs(first.list, [post], w.clock.now)).toEqual([]);
    // an invite a PC joins with by itself needs no Add, and gives nobody one
    const auto = await invited(true);
    expect(await invitedPcs(auto.first.list, [await posted(auto.w, auto.first, auto.invite, auto.pc)], auto.w.clock.now)).toEqual([]);
  });
});

describe("Add for a PC that joined with an invite", () => {
  it("has the account admit the PC, signs its entry with no number, and ends the invite in the same request", async () => {
    const { w, first, invite, pc } = await invited();
    // the PC used the invite at the account service: it is listed, and waits to be admitted
    await w.fake.fetch(`${w.origin}/v1/pcs/${pc.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${w.fake.issueToken(w.account, { device: true })}`, "content-type": "application/json" }, body: JSON.stringify({ label: "PC", public_key: pc.endpoint, relay: "wss://relay.test" }) });
    await postPcKeys(w.fake.fetch, w.origin, w.fake.issueToken(w.account, { device: true }), pc, first.list.writer()!.list);
    const [found] = await invitedPcs(first.list, [await posted(w, first, invite, pc)], w.clock.now);
    let admitted = 0;
    const outcome = await addInvitedPc(first.list, found!, { label: "Studio PC", os: "linux" }, { ...noWait, admit: async () => { admitted += 1; await first.service.admitPc(pc.server_id); } });
    expect([outcome, admitted]).toEqual([{ added: true }, 1]);
    const sent = first.sent.filter((each) => each.route.endsWith("/entries")).at(-1)!.body!.entries as string[];
    expect(sent.map((text) => readBody(entryFromText(text).body).kind)).toEqual(["pc", "remove"]);
    expect(first.list.view().pcs.map((row) => [row.endpoint, row.name?.label])).toEqual([[pc.endpoint, "Studio PC"]]);
    // the invite is spent: no second PC is offered for it, whatever proof is shown
    const other = await askingPc();
    expect(await invitedPcs(first.list, [await posted(w, first, invite, other)], w.clock.now)).toEqual([]);
  });
});
