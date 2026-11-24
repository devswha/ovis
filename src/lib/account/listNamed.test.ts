import { describe, expect, it } from "bun:test";
import { readKind, signCard } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { askingPc, listWorld, type AskingPc } from "./accountList.test-helpers.ts";
import type { PcFetch } from "./join.ts";
import { NAMED_ASKS, nameListToPc } from "./listNamed.ts";

type World = ReturnType<typeof listWorld>;

/** A device in its account's list, and the PC whose QR code it scanned, as that PC answers over the pairing's session. */
async function scanned(w: World = listWorld()) {
  const phone = await w.device({ label: "Dana's phone" });
  await phone.list.sync();
  const pc = await askingPc();
  const asked: Record<string, unknown>[] = [];
  /** what the PC answers: its card for the list it is named, and `added` once the list holds its own key at its relay key */
  const answers = { status: 200 as number, code: "", card: null as string | null, key: pc.key, reads: true };
  const fetch: PcFetch = async (path, init) => {
    if (path !== "/api/account/list/named") return new Response(null, { status: 404 });
    const body = JSON.parse(String(init?.body)) as { account: string; list: string };
    asked.push(body);
    if (answers.status !== 200) return Response.json({ error: { code: answers.code } }, { status: answers.status });
    const held = w.held();
    const row = held.state.pcs[pc.endpoint];
    if (answers.reads && row !== undefined && row.removed === null && row.key === pc.key) return Response.json({ state: "added", account: body.account });
    const card = answers.card ?? await signCard({ key: pc.key, enc: pc.enc, list: body.list, endpoint: pc.endpoint, invite: null }, pc.signs);
    // as the PC does: it posts the same card to the account service (the second lock), listed by the scan's admission
    await postKeys(w, phone.session.access_token, pc, body.list);
    return Response.json({ state: "waiting", standing: "waiting", key: answers.key, enc: pc.enc, card });
  };
  const name = (more: Partial<Parameters<typeof nameListToPc>[0]> = {}) => nameListToPc({
    fetch, list: phone.list, account: w.account, endpoint: pc.endpoint, names: { label: "Desk", os: "linux" }, admit: async () => { admitted.push(pc.server_id); }, wait: async () => {}, ...more,
  });
  const admitted: string[] = [];
  return { w, phone, pc, asked, answers, admitted, name };
}

async function postKeys(w: World, bearer: string, pc: AskingPc, list: string): Promise<void> {
  const { postPcKeys } = await import("./accountList.test-helpers.ts");
  await postPcKeys(w.fake.fetch, w.origin, bearer, pc, list);
}

describe("naming the account's list to a PC whose QR code this device scanned", () => {
  it("takes the PC's card from the session, signs the PC into the list with it, and hears from the PC that it read the entry", async () => {
    const { w, phone, pc, asked, admitted, name } = await scanned();
    expect(await name()).toEqual({ outcome: "added" });
    expect(asked).toEqual([{ account: w.account, list: w.held().id }, { account: w.account, list: w.held().id }]);
    expect(admitted).toEqual([pc.server_id]);
    const body = readBody(entryFromText(w.held().entries.at(-1)!).body);
    expect([body.signer, readKind(body)]).toMatchObject([(await phone.keys()).key, { kind: "pc", key: pc.key, endpoint: pc.endpoint, enc: pc.enc }]);
    expect((await phone.list.sync()).pcs.map((row) => row.name?.label)).toEqual(["Desk"]);
  });

  it("says the entry is placed where the PC does not say in time that it read it, and asks it no more often than it counts", async () => {
    const { w, asked, answers, name } = await scanned();
    answers.reads = false;
    expect(await name()).toEqual({ outcome: "placed" });
    expect([asked.length, w.held().entries.length]).toEqual([NAMED_ASKS, 2]);
  });

  it("sends the link as before to a PC that has no such call, and signs nothing", async () => {
    const { w, admitted, answers, name } = await scanned();
    answers.status = 404;
    answers.code = "not_found";
    expect(await name()).toEqual({ outcome: "none" });
    expect([admitted, w.held().entries.length]).toEqual([[], 1]);
  });

  it("signs nothing for a card that is not the PC's own for this list and this session's relay key", async () => {
    const { w, pc, admitted, answers, name } = await scanned();
    const other = await askingPc();
    // a card for another relay key, and a key that did not sign the card
    answers.card = await signCard({ key: pc.key, enc: pc.enc, list: w.held().id, endpoint: other.endpoint, invite: null }, pc.signs);
    expect(await name()).toEqual({ outcome: "refused", why: "card_invalid" });
    answers.card = null;
    answers.key = other.key;
    expect(await name()).toEqual({ outcome: "refused", why: "card_invalid" });
    // the session is bound to another PC's relay key than the card names
    answers.key = pc.key;
    expect(await name({ endpoint: other.endpoint })).toEqual({ outcome: "refused", why: "card_invalid" });
    expect([admitted, w.held().entries.length]).toEqual([[], 1]);
  });

  it("says what the PC refused, and signs nothing", async () => {
    const { w, answers, name } = await scanned();
    for (const [status, code] of [[409, "account_mismatch"], [409, "list_removed"], [409, "pairing_ended"], [403, "link_required"], [503, "account_unavailable"]] as const) {
      answers.status = status;
      answers.code = code;
      expect(await name()).toEqual({ outcome: "refused", why: code });
    }
    expect(w.held().entries.length).toBe(1);
  });

  it("names nothing from a device that may not write to its list", async () => {
    const { w, asked, name } = await scanned();
    const waiting = await w.device({ label: "Tablet" });
    await waiting.list.sync();
    expect(await name({ list: waiting.list })).toEqual({ outcome: "none" });
    expect(asked).toEqual([]);
  });
});
