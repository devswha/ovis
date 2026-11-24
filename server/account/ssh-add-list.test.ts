/**
 * The adding PC's steps of an add over SSH by the account's signed list (ssh-add-list.ts), with the take and the list
 * stood in for: what goes to the other PC, and when the forward is closed.
 */
import { expect, test } from "bun:test";
import type { AccountAddNamed } from "../account-add-channel.ts";
import type { AccountAddCard } from "../machines.ts";
import type { AddedPc, AllowOutcome, AllowRefusal } from "./list-follow.ts";
import { addOverSshByList, type SshListDeps, type SshListTaken } from "./ssh-add-list.ts";

const LIST = "a".repeat(64);
const ADDER = "adder-key";
const CARD: AccountAddCard = { key: "pc-key", enc: "pc-enc", card: "pc-card", endpoint: "b".repeat(64), label: "Other PC" };
const ADDED: SshListTaken = { account: "acct_1", relay: { phase: "online", blocked: null } };

/** A list this PC follows as a full signer, and a take that answers from `answers` in turn; what each was asked is kept. */
function fixture(options: { refusal?: AllowRefusal | null; answers: (SshListTaken | { waiting: AccountAddCard })[]; added?: AllowOutcome }) {
  const takes: AccountAddNamed[] = [];
  const signed: AddedPc[] = [];
  let ended = 0;
  const deps: SshListDeps = {
    list: {
      allowRefusal: () => options.refusal ?? null,
      status: () => ({ pinned_list: LIST }) as ReturnType<SshListDeps["list"]["status"]>,
      own: async () => ({ serverId: "0".repeat(32), endpoint: "c".repeat(64), keys: { key: ADDER } }) as Awaited<ReturnType<SshListDeps["list"]["own"]>>,
      addPc: async (pc) => { signed.push(pc); return options.added ?? { allowed: { id: LIST, seq: 3, hash: "d".repeat(64) } }; },
    },
    take: async (named) => { takes.push(named); const next = options.answers.shift(); if (next === undefined) throw new Error("no more answers"); return next; },
    end: async () => { ended++; },
    wait: async () => {},
  };
  return { deps, takes, signed, ended: () => ended };
}

test("a PC that cannot sign names no list to the other PC: no take goes, nothing is signed", async () => {
  for (const refusal of ["not_signer", "alarm", "behind", "stopped", "unavailable"] as const) {
    const made = fixture({ refusal, answers: [] });
    expect(await addOverSshByList(made.deps)).toMatchObject({ refused: { code: "list_cannot_add", status: 409 } });
    expect(made.takes).toEqual([]);
    expect(made.signed).toEqual([]);
  }
});

test("the take names this PC's list and its own key; the card that comes back is signed with the name and relay key the inspect read", async () => {
  const made = fixture({ answers: [{ waiting: CARD }, ADDED] });
  expect(await addOverSshByList(made.deps)).toEqual(ADDED);
  expect(made.takes).toEqual([{ list: LIST, adder: ADDER }, { list: LIST, adder: ADDER }]);
  expect(made.signed).toEqual([CARD]);
  expect(made.ended()).toBe(0);
});

test("the other PC in the list already: nothing is signed, and its answer is the add's", async () => {
  const made = fixture({ answers: [ADDED] });
  expect(await addOverSshByList(made.deps)).toEqual(ADDED);
  expect(made.signed).toEqual([]);
  expect(made.takes).toHaveLength(1);
});

test("an entry this PC could not place ends the add there: the forward is closed and no second take goes", async () => {
  for (const [refused, code] of [["not_written", "list_not_added"], ["refused", "list_not_added"], ["head_lost", "list_not_added"], ["service_away", "take_unanswered"], ["alarm", "list_cannot_add"]] as const) {
    const made = fixture({ answers: [{ waiting: CARD }], added: { refused, detail: null } });
    expect(await addOverSshByList(made.deps)).toMatchObject({ refused: { code } });
    expect(made.takes).toHaveLength(1);
    expect(made.ended()).toBe(1);
  }
});

test("a PC that has not read its entry after the last take: in the list, not following it yet, and said so; the forward is closed", async () => {
  const made = fixture({ answers: [{ waiting: CARD }, { waiting: CARD }, { waiting: CARD }, { waiting: CARD }, { waiting: CARD }, { waiting: CARD }] });
  expect(await addOverSshByList(made.deps)).toMatchObject({ refused: { code: "take_unanswered" } });
  expect(made.signed).toHaveLength(1);
  expect(made.takes).toHaveLength(6);
  expect(made.ended()).toBe(1);
});

test("a take the other PC refuses is thrown on as it came", async () => {
  const made = fixture({ answers: [] });
  made.deps.take = async () => { throw Object.assign(new Error("That PC is in another account"), { code: "other_account" }); };
  await expect(addOverSshByList(made.deps)).rejects.toMatchObject({ code: "other_account" });
});
