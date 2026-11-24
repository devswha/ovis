import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import {
  LIST_LEVEL, admitsDevice, holdsPc, listView, namesFields, readNames, replayList, sealEpoch, signCard, signListEntry,
  type ListNames, type ListSigner, type ListState,
} from "./account-list.ts";
import { epochKeyCommitment, newEpochKey, nextEpoch, openSealed, sealFields, type EpochKey } from "./account-list-seal.ts";
import {
  LIST_NAMING_PREFIX, MIGRATION_CARRIED_MAX, MIGRATION_KNOWN_SECONDS, MIGRATION_RUNNING_SECONDS, MIGRATION_WITNESS_SECONDS, MigrationError, devicePlace, heirOf, heldNaming, joinVerdict, migrationPlan, namingBytes,
  ownEvidence, pinVerdict, rekeys, signMigration, signNaming, signRotation, standsFor, standsFor as heldBy,
  type JoinRefusal, type JoinVerdict, type KnownDevice, type KnownPc, type LetIn, type MigratingDevice, type MigrationKnown, type MigrationPlan, type MigrationSeals, type MigrationStart, type Naming,
  type PcAnswer, type PcWitness, type PinRefusal, type PinVerdict, type SignedNaming,
} from "./account-list-migrate.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const DAY = MIGRATION_WITNESS_SECONDS;
const RUN = MIGRATION_RUNNING_SECONDS;
const T0 = 1767225600;
const ACCOUNT = "TEST-ONLY-account";

const spki = async (key: CryptoKey) => toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", key)));
async function signer(): Promise<ListSigner> {
  const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
  return { key: await spki(pair.publicKey), privateKey: pair.privateKey };
}
/** A device as it is signed in: the key its sign-in registered, its account key, its encryption key and its name. */
interface Device extends MigratingDevice { readonly label: string }
async function device(label: string): Promise<Device> {
  const enc = await spki((await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])).publicKey);
  return { label, signIn: await signer(), member: await signer(), enc, names: { label, os: "ios" } };
}
const phone = await device("Phone");
const tablet = await device("Tablet");
const laptop = await device("Laptop");
/** A key the account service made up, or one it registered for somebody who is not the person. */
const stranger = await device("Stranger");
/** A PC's relay key. */
const E = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const names = (label: string): ListNames => ({ label, os: "linux" });
/** A key in its one spelling whose point is not on the curve. */
const offCurve = (() => {
  const bytes = fromBase64Url(tablet.signIn.key);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  return toBase64Url(bytes);
})();
/** The same device after it signed in again: another sign-in key, the same account key. */
const signedInAgain = async (one: Device): Promise<Device> => ({ ...one, signIn: await signer() });

/** The caller's side of sealing, with the real keys. */
function sealer(): { readonly seals: MigrationSeals; readonly keys: Map<number, EpochKey>; readonly wrapped: string[][] } {
  const keys = new Map<number, EpochKey>();
  const wrapped: string[][] = [];
  const current = (epoch: number): EpochKey => {
    const key = keys.get(epoch);
    if (key === undefined) throw new Error(`no key of epoch ${epoch}`);
    return key;
  };
  return {
    keys, wrapped,
    seals: {
      async genesis(given) {
        const epoch = newEpochKey(0);
        keys.set(0, epoch);
        const opens = epochKeyCommitment({ list: "", epoch });
        return { opens, sealed: given === null ? null : { epoch: 0, bytes: await sealFields({ place: { list: "", seq: 0 }, epoch, commitment: opens, fields: namesFields(given) }) } };
      },
      async names(place, epoch, given) {
        return { epoch: epoch.epoch, bytes: await sealFields({ place, epoch: current(epoch.epoch), commitment: epoch.opens, fields: namesFields(given) }) };
      },
      async next(list, epoch, members) {
        const made = await nextEpoch({ list, current: current(epoch), members });
        keys.set(made.epoch.epoch, made.epoch);
        wrapped.push(made.wraps.map((wrap) => wrap.member));
        return { opens: made.commitment, link: made.link };
      },
    },
  };
}

const plan = (devices: readonly Device[], pcs: readonly number[] = []): Pick<MigrationPlan, "devices" | "pcs"> => ({
  devices: devices.map((one) => ({ key: one.signIn.key, names: one.names })),
  pcs: pcs.map((n) => ({ endpoint: E(n), names: names(`PC ${n}`) })),
});
async function replay(texts: readonly string[]): Promise<ListState> {
  const replayed = await replayList(texts, LIST_LEVEL, { saved: null });
  if (replayed.member === null || replayed.stopped !== null) throw new Error("the list does not replay");
  return replayed.member.state;
}
/** A list as the first device makes it: entry 0 and the whole run, one request. */
async function migrated(first: Device, carried: Pick<MigrationPlan, "devices" | "pcs">, at = T0) {
  const sealed = sealer();
  const made = await signMigration(ACCOUNT, carried, first, at, sealed.seals);
  return { texts: made.entries.map((entry) => entry.text), state: made.state, sealed, list: made.list };
}

/** A key somebody has let in: for a month and with the PC running all that time, unless a test says otherwise. */
const OLD = { wall: 30 * DAY, ran: 30 * DAY };
type Row = Device | readonly [Device, Partial<Pick<LetIn, "wall" | "ran" | "idle">>] | LetIn;
const rows = (given: readonly Row[]): LetIn[] => given.map((one) => ("key" in one ? one : "signIn" in one ? { key: one.signIn.key, ...OLD } : { key: one[0].signIn.key, ...OLD, ...one[1] }));
const witness = (given: readonly Row[], rest: Partial<Pick<PcWitness, "removed" | "account">> = {}): PcWitness => ({ account: rest.account ?? ACCOUNT, rows: rows(given), removed: rest.removed ?? [] });
const listed = (one: Device, eligible = true): KnownDevice => ({ key: one.signIn.key, eligible, names: one.names });
const says = (given: readonly Row[], rest: Partial<PcAnswer> = {}): PcAnswer => ({ account: ACCOUNT, pinned: null, admits: rows(given), removed: [], ...rest });
const pc = (n: number, answer: PcAnswer | null, rest: Partial<Pick<KnownPc, "paired" | "known">> = {}): KnownPc =>
  ({ endpoint: E(n), paired: rest.paired ?? false, known: rest.known === undefined ? 30 * DAY : rest.known, says: answer, names: names(`PC ${n}`) });
const known = (devices: readonly KnownDevice[], pcs: readonly KnownPc[], removed: readonly string[] = []): MigrationKnown =>
  ({ account: ACCOUNT, self: phone.signIn.key, member: phone.member.key, devices, removed, pcs });
const started = (start: MigrationStart): MigrationPlan => {
  if (!start.start) throw new Error(`no start: ${start.why}`);
  return start.plan;
};
const pinWord = (verdict: PinVerdict): PinRefusal | "pin" => (verdict.pin ? "pin" : verdict.why);
const joinWord = (verdict: JoinVerdict): JoinRefusal | "pin" => (verdict.pin ? "pin" : verdict.why);
/** What a device says to a PC in its session, as the PC holds it once it checked the signature: the session's own key is the PC's to say. */
async function named(state: ListState, who: Device, session: string, endpoint = E(1)): Promise<Naming> {
  const signed = await signNaming(state, { member: who.member, session, endpoint });
  if (signed === null) throw new Error("nothing to name");
  const held = await heldNaming(ACCOUNT, endpoint, session, signed);
  if (held === null) throw new Error("the naming does not hold");
  return held;
}
const code = async (run: () => Promise<unknown>) => await run().then(() => null, (error: unknown) => (error instanceof MigrationError ? error.code : String(error)));

describe("a day, by a PC's own two clocks", () => {
  test("a key counts when it has been let in for a day by the wall clock AND the PC has run six hours with it let in", async () => {
    const made = await migrated(phone, plan([tablet]));
    const naming = await named(made.state, phone, phone.signIn.key);
    const word = (wall: number, ran: number) => pinVerdict(made.state, naming, witness([[phone, { wall, ran }]]));
    expect([DAY, RUN]).toEqual([86400, 21600]);
    expect(pinWord(word(DAY, RUN))).toBe("pin");
    // A PC with no battery clock whose time jumped at boot: a day by the wall clock, and it has run ten minutes.
    expect(word(3 * DAY, 600)).toEqual({ pin: false, why: "session_new", waits: true, wait: RUN - 600 });
    // A PC that never sleeps: six hours of running are no day.
    expect(word(RUN, RUN)).toEqual({ pin: false, why: "session_new", waits: true, wait: DAY - RUN });
    expect([pinWord(word(DAY - 1, RUN)), pinWord(word(DAY, RUN - 1))]).toEqual(["session_new", "session_new"]);
    // What is no duration is no record.
    for (const odd of [-1, Number.NaN, 1.5, "86400" as unknown as number]) expect([pinWord(word(odd, RUN)), pinWord(word(DAY, odd))]).toEqual(["session_unknown", "session_unknown"]);
    // A key named twice counts by its shorter stretch.
    expect(pinWord(pinVerdict(made.state, naming, witness([phone, [phone, { wall: 60, ran: 60 }]])))).toBe("session_new");
  });
});

describe("whom the first device carries in", () => {
  test("a device that EVERY PC it knows, and that answered, has let in for a day; and the PCs it knows by its own record", () => {
    const start = migrationPlan(known([listed(phone), listed(tablet), listed(laptop)], [pc(1, says([phone, tablet, laptop])), pc(2, says([phone, tablet]))]));
    expect(started(start)).toEqual({
      devices: [{ key: tablet.signIn.key, names: tablet.names }],
      pcs: [{ endpoint: E(1), names: names("PC 1") }, { endpoint: E(2), names: names("PC 2") }],
      left: { devices: [{ key: laptop.signIn.key, why: "unwitnessed" }], pcs: [] },
    });
  });

  test("no single PC adds a key: one the service planted on one PC, or put into the directory itself, carries nothing", () => {
    // The service adds a key to what it tells the first device, and plants it on one PC for a month.
    const one = migrationPlan(known([listed(phone), listed(stranger)], [pc(1, says([phone, stranger])), pc(2, says([phone]))]));
    expect([started(one).devices, started(one).left.devices]).toEqual([[], [{ key: stranger.signIn.key, why: "unwitnessed" }]]);
    // A PC only the directory names, or one this device first opened an hour ago, is no witness whatever it answers.
    const fake = migrationPlan(known([listed(phone), listed(stranger)], [pc(1, says([phone])), pc(8, says([phone, stranger]), { known: null }), pc(9, says([phone, stranger]), { known: 3600 })]));
    expect(started(fake).left).toEqual({ devices: [{ key: stranger.signIn.key, why: "unwitnessed" }], pcs: [{ endpoint: E(8), why: "unknown_pc" }, { endpoint: E(9), why: "unknown_pc" }] });
    expect(migrationPlan(known([listed(phone)], [pc(8, says([phone]), { known: null }), pc(9, says([phone]), { known: 6 * DAY }), pc(3, null)]))).toEqual({ start: false, why: "no_witness", wait: null });
    // A PC the person paired this device with at the PC is known at once.
    expect(started(migrationPlan(known([listed(phone), listed(tablet)], [pc(1, says([phone, tablet]), { known: null, paired: true })]))).devices).toHaveLength(1);
    // A PC it was never paired with is one it knows after seven days of sessions, not one.
    expect([MIGRATION_KNOWN_SECONDS, ownEvidence({ paired: false, known: 7 * DAY }), ownEvidence({ paired: false, known: 7 * DAY - 1 }), ownEvidence({ paired: false, known: null }), ownEvidence({ paired: true, known: null }),
      ownEvidence({ paired: false, known: Number.NaN })]).toEqual([604800, true, false, false, true, false]);
  });

  test("a key the PCs have let in for less than a day holds the start back; what is left, said plainly: after a day it is carried in, whoever put it there", () => {
    const young = { wall: 3600, ran: 3600 };
    expect(migrationPlan(known([listed(phone), listed(stranger)], [pc(1, says([phone, [stranger, young]])), pc(2, says([phone, stranger]))]))).toEqual({ start: false, why: "too_new", wait: DAY - 3600 });
    // The longest wait among the PCs decides, by each PC's own two clocks.
    expect(migrationPlan(known([listed(phone), listed(tablet)], [pc(1, says([phone, [tablet, { wall: DAY, ran: 60 }]])), pc(2, says([phone, [tablet, { wall: DAY - 60, ran: RUN }]]))]))).toEqual({ start: false, why: "too_new", wait: RUN - 60 });
    expect(started(migrationPlan(known([listed(phone), listed(stranger)], [pc(1, says([phone, [stranger, { wall: DAY, ran: RUN }]]))]))).devices.map((row) => row.key)).toEqual([stranger.signIn.key]);
  });

  test("a device the service hides is not carried in, and nothing else changes", () => {
    const start = started(migrationPlan(known([listed(phone), listed(laptop)], [pc(1, says([phone, tablet, laptop]))])));
    expect([start.devices.map((row) => row.key), start.left.devices]).toEqual([[laptop.signIn.key], []]);
  });

  test("a device that was removed the day before stays out: where the service says so, where this device blocked it, and where the service lists it again", () => {
    const removed = migrationPlan(known([listed(phone), listed(tablet, false)], [pc(1, says([phone]))], [tablet.signIn.key]));
    expect(started(removed).left.devices).toEqual([{ key: tablet.signIn.key, why: "removed" }]);
    // This device signed the block itself and has not sent it yet; the service and the PC still name the tablet.
    const own = migrationPlan(known([listed(phone), listed(tablet)], [pc(1, says([phone, tablet]))], [tablet.signIn.key]));
    expect(started(own).left.devices).toEqual([{ key: tablet.signIn.key, why: "removed" }]);
    // The service lists it as in again; one PC holds the removal.
    const relisted = migrationPlan(known([listed(phone), listed(tablet)], [pc(1, says([phone, tablet])), pc(2, says([phone], { removed: [tablet.signIn.key] }))]));
    expect([started(relisted).devices, started(relisted).left.devices]).toEqual([[], [{ key: tablet.signIn.key, why: "removed_at_pc" }]]);
  });

  test("a key the service says no PC lets in, a key that is no key, and this device's own account key", () => {
    const start = started(migrationPlan(known([listed(phone), listed(tablet, false), { key: "no-key", eligible: true, names: null }, { key: offCurve, eligible: true, names: null }, { key: phone.member.key, eligible: true, names: null }],
      [pc(1, says([phone, tablet, { key: offCurve, ...OLD }, { key: phone.member.key, ...OLD }]))])));
    expect([start.devices, start.left.devices]).toEqual([[], [{ key: tablet.signIn.key, why: "not_eligible" }, { key: "no-key", why: "form" }, { key: offCurve, why: "form" }]]);
  });

  test("the device's own key is held to the same, and an answer for another account is no answer", () => {
    const no = (why: string, wait: number | null = null) => ({ start: false, why, wait });
    expect(migrationPlan(known([listed(tablet)], [pc(1, says([phone, tablet]))]))).toEqual(no("self_unlisted") as MigrationStart);
    expect(migrationPlan(known([listed(phone, false)], [pc(1, says([phone]))]))).toEqual(no("self_unlisted") as MigrationStart);
    expect(migrationPlan(known([listed(phone)], [pc(1, says([phone]))], [phone.signIn.key]))).toEqual(no("self_removed") as MigrationStart);
    expect(migrationPlan(known([listed(phone)], [pc(1, says([phone])), pc(2, says([phone], { removed: [phone.signIn.key] }))]))).toEqual(no("self_removed") as MigrationStart);
    expect(migrationPlan(known([listed(phone)], [pc(1, says([phone])), pc(2, says([tablet]))]))).toEqual(no("self_unwitnessed") as MigrationStart);
    expect(migrationPlan(known([listed(phone)], [pc(1, says([[phone, { wall: 60, ran: 60 }]]))]))).toEqual(no("too_new", DAY - 60) as MigrationStart);
    expect(migrationPlan(known([listed(phone)], [pc(1, says([phone], { account: "TEST-ONLY-other" }))]))).toEqual(no("no_witness") as MigrationStart);
  });

  test("a PC is carried in by this device's own record of it, answered or not, and one named twice once", () => {
    const start = started(migrationPlan(known([listed(phone)], [pc(1, says([phone])), pc(2, null), pc(2, null), pc(3, null, { known: null, paired: true }), pc(5, says([phone]), { known: null }), { ...pc(6, says([phone])), endpoint: "not-a-relay-key" }])));
    expect([start.pcs.map((row) => row.endpoint), start.left.pcs]).toEqual([[E(1), E(2), E(3)], [{ endpoint: E(5), why: "unknown_pc" }, { endpoint: "not-a-relay-key", why: "form" }]]);
  });

  test("an account with more than a list carries in: the devices a PC saw in use last are kept", async () => {
    const many = await Promise.all(Array.from({ length: MIGRATION_CARRIED_MAX + 3 }, (_, index) => device(`Device ${index}`)));
    const keyOf = (index: number): string => many[index]?.signIn.key ?? "";
    // Device 0 was last used a year ago, Device 1 never as far as the PC knows, Device 2 a month ago; the others this week.
    const idle = (index: number): number | null => (index === 0 ? 365 * DAY : index === 1 ? null : index === 2 ? 31 * DAY : index);
    const answer = says([phone, ...many.map((one, index): LetIn => ({ key: one.signIn.key, ...OLD, idle: idle(index) }))]);
    const start = started(migrationPlan(known([listed(phone), ...many.map((one) => listed(one))], [pc(1, answer), pc(2, null)])));
    expect([start.devices.length, start.devices[0]?.key, start.pcs, start.left.devices.map((row) => row.key), start.left.pcs.map((row) => row.why)]).toEqual([
      MIGRATION_CARRIED_MAX, keyOf(3), [], [keyOf(0), keyOf(1), keyOf(2)], ["over_limit", "over_limit"],
    ]);
    // Where all fit, nothing is reordered.
    const few = started(migrationPlan(known([listed(phone), listed(many[0] ?? phone), listed(many[5] ?? phone)], [pc(1, answer)])));
    expect(few.devices.map((row) => row.key)).toEqual([keyOf(0), keyOf(5)]);
    // The whole birth is one request: entry 0, 64 carried, the hand-over and the epoch.
    const made = await migrated(phone, start);
    expect([made.texts.length, made.state.carrying, listView(made.state).devices.filter((row) => row.carried).length]).toEqual([MIGRATION_CARRIED_MAX + 3, false, MIGRATION_CARRIED_MAX]);
    expect(await code(() => signMigration(ACCOUNT, { devices: [...start.devices, { key: keyOf(0), names: null }], pcs: [] }, phone, T0, sealer().seals))).toBe("too_many");
  });
});

describe("the entries of a list that carries an account in", () => {
  test("one request: entry 0 by the sign-in key, the run, the hand-over to the member key, the next epoch; every entry counts", async () => {
    const made = await migrated(phone, plan([tablet, laptop], [1, 2]));
    const replayed = await replayList(made.texts, LIST_LEVEL, { saved: null });
    expect(replayed.took.map((item) => item.outcome.outcome)).toEqual(["counts", "counts", "counts", "counts", "counts", "counts", "counts"]);
    const state = await replay(made.texts);
    expect([state, state.list]).toEqual([made.state, made.list]);
    const view = listView(state);
    expect(view.devices.map((row) => [row.key, row.carried, row.ended, row.enc])).toEqual([
      [phone.signIn.key, false, 5, phone.enc], [tablet.signIn.key, true, null, null], [laptop.signIn.key, true, null, null], [phone.member.key, false, null, phone.enc],
    ]);
    expect(view.pcs.map((row) => [row.endpoint, row.how, row.key])).toEqual([[E(1), "carried", null], [E(2), "carried", null]]);
    expect([state.account, state.carrying, state.epoch, view.signers]).toEqual([ACCOUNT, false, 1, []]);
    // A pinned PC lets in whatever key the list holds: the old apps by the keys they have, the first device by the key it goes on with.
    expect([phone.signIn, tablet.signIn, laptop.signIn, phone.member, stranger.signIn].map((one) => admitsDevice(state, one.key, T0))).toEqual([null, "drive", "drive", "drive", null]);
    expect([holdsPc(state, E(1)), holdsPc(state, E(3))]).toEqual([true, false]);
    expect([sealEpoch(state, T0)?.epoch, made.sealed.wrapped]).toEqual([1, [[phone.enc]]]);
  });

  test("each entry seals the name of the member it lets in, under the epoch that was current", async () => {
    const made = await migrated(phone, plan([tablet], [1]));
    const key = made.sealed.keys.get(0);
    if (key === undefined) throw new Error("no key of epoch 0");
    const replayed = await replayList(made.texts, LIST_LEVEL, { saved: null });
    const labels: (string | null)[] = [];
    for (const { held } of replayed.took.slice(0, 4)) {
      const sealed = held.body.own.find((item) => item.name === "sealed")?.value;
      const opened = sealed === undefined ? null : await openSealed({ place: { list: held.body.seq === 0 ? "" : held.list, seq: held.body.seq }, epoch: key, sealed });
      labels.push(opened !== null && opened.open ? (readNames(opened.value)?.label ?? null) : null);
    }
    expect(labels).toEqual(["Phone", "Tablet", "PC 1", "Phone"]);
  });

  test("nothing is signed, entry 0 included, for a key off the curve, one of the device's own, a relay key out of form, or a device's own key that is none", async () => {
    const bad: ListSigner = { key: offCurve, privateKey: tablet.member.privateKey };
    const refused: [Pick<MigrationPlan, "devices" | "pcs">, Device][] = [
      [{ devices: [{ key: tablet.signIn.key, names: null }, { key: offCurve, names: null }], pcs: [] }, phone], [{ devices: [], pcs: [{ endpoint: "not-a-relay-key", names: null }] }, phone],
      [{ devices: [{ key: phone.member.key, names: null }], pcs: [] }, phone], [{ devices: [{ key: phone.signIn.key, names: null }], pcs: [] }, phone],
      [plan([]), { ...phone, member: bad }], [plan([]), { ...phone, enc: offCurve }], [plan([]), { ...phone, signIn: bad }],
    ];
    for (const [carried, first] of refused) {
      const sealed = sealer();
      expect(await code(() => signMigration(ACCOUNT, carried, first, T0, sealed.seals))).toBe("key_invalid");
      expect(sealed.keys.size).toBe(0);
    }
  });
});

describe("a device that was signed in before the list", () => {
  const keys = (one: Device) => ({ signIn: one.signIn.key, member: one.member.key });

  test("it learns from the list that it was carried in, and hands its place to its member key", async () => {
    const made = await migrated(phone, plan([tablet, laptop]));
    expect([devicePlace(made.state, keys(tablet)), devicePlace(made.state, keys(phone)), devicePlace(made.state, keys(stranger))]).toEqual([{ at: "carried", wait: false }, { at: "member" }, { at: "absent", wait: false }]);
    const rotated = await signRotation(made.state, tablet, T0 + 30, null);
    const state = await replay([...made.texts, rotated.text]);
    expect(state).toEqual(rotated.state);
    expect([devicePlace(state, keys(tablet)), admitsDevice(state, tablet.signIn.key, T0 + 60), admitsDevice(state, tablet.member.key, T0 + 60)]).toEqual([{ at: "member" }, null, "drive"]);
    expect(listView(state).devices.find((row) => row.key === tablet.member.key)).toMatchObject({ by: tablet.signIn.key, carried: false, enc: tablet.enc, power: "full" });
    // A PC moves the row; it is the same device. The laptop, which has not run the new app, stays where it was.
    expect(rekeys(made.state, state)).toEqual([{ from: tablet.signIn.key, to: tablet.member.key }]);
    expect([heirOf(state, tablet.signIn.key), heirOf(state, laptop.signIn.key), standsFor(state, phone.signIn.key), standsFor(state, laptop.signIn.key), standsFor(state, stranger.signIn.key)])
      .toEqual([tablet.member.key, null, phone.member.key, laptop.signIn.key, null]);
    expect([rekeys(null, state), rekeys({ ...made.state, needs_replay: { seq: 1, hash: "00".repeat(32) } }, state)]).toEqual([[], []]);
    expect([await code(() => signRotation(state, tablet, T0 + 90, null)), await code(() => signRotation(made.state, { ...tablet, member: phone.member }, T0 + 60, null))]).toEqual(["not_in", "has_member"]);
    for (const broken of [{ ...tablet, member: { key: offCurve, privateKey: tablet.member.privateKey } }, { ...tablet, enc: offCurve }]) expect(await code(() => signRotation(made.state, broken, T0 + 60, null))).toBe("key_invalid");
    expect(await code(() => signRotation({ ...made.state, needs_replay: { seq: 1, hash: "00".repeat(32) } }, tablet, T0 + 60, null))).toBe("stopped");
  });

  test("shown only the beginning of a birth, it waits and signs nothing, however old the beginning is", async () => {
    const made = await migrated(phone, plan([tablet, laptop]));
    // An honest log never holds a part of the one request. A service that shows entry 0 and the tablet's entry is lying.
    const shown = await replay(made.texts.slice(0, 2));
    expect([devicePlace(shown, keys(tablet)), devicePlace(shown, keys(laptop)), devicePlace(shown, keys(phone))]).toEqual([{ at: "carried", wait: true }, { at: "absent", wait: true }, { at: "first" }]);
    expect([await code(() => signRotation(shown, tablet, T0 + 3600, null)), await code(() => signRotation(shown, tablet, T0 + 30 * DAY, null))]).toEqual(["run_open", "run_open"]);
    expect(joinWord(joinVerdict(shown, keys(tablet), [pc(1, says([phone, tablet]))]))).toBe("run_open");
  });

  test("a device that was removed is out, whichever of its keys the removal named; a device a member let in is a member", async () => {
    const made = await migrated(phone, plan([tablet, laptop]));
    const removed = await signListEntry(made.state, { kind: "remove", ends: laptop.signIn.key }, phone.member, T0 + 60);
    expect(devicePlace(removed.state, keys(laptop))).toEqual({ at: "out" });
    const rotated = await signRotation(made.state, tablet, T0 + 60, null);
    const out = await signListEntry(rotated.state, { kind: "remove", ends: tablet.member.key }, phone.member, T0 + 90);
    expect([devicePlace(out.state, keys(tablet)), standsFor(out.state, tablet.signIn.key), rekeys(rotated.state, out.state)]).toEqual([{ at: "out" }, null, []]);
    const added = await device("Added");
    const allowed = await signListEntry(made.state, {
      kind: "device", key: added.member.key, power: "full", role: "drive", until: null, enc: added.enc, sealed: null, rotates: false,
      card: await signCard({ key: added.member.key, enc: added.enc, list: made.list, endpoint: null, invite: null }, added.member.privateKey),
    }, phone.member, T0 + 60);
    expect(devicePlace(allowed.state, keys(added))).toEqual({ at: "member" });
  });
});

describe("a carried device follows a list it did not make only when the PCs it knows say who started it", () => {
  const keys = (one: Device) => ({ signIn: one.signIn.key, member: one.member.key });

  test("every PC it knows, and that answers, has let the first signer in for a day or is pinned to that very list; one must answer", async () => {
    const made = await migrated(phone, plan([tablet, laptop], [1]));
    const ask = (pcs: readonly KnownPc[]) => joinVerdict(made.state, keys(tablet), pcs);
    expect(ask([pc(1, says([phone, tablet])), pc(2, says([], { pinned: made.list }))])).toEqual({ pin: true });
    expect(ask([pc(1, says([phone]), { known: null, paired: true })])).toEqual({ pin: true });
    // Nobody answers yet, or only PCs the directory names: it waits, and goes on as before the list.
    expect(ask([pc(1, null), pc(8, says([phone]), { known: null }), pc(9, says([phone]), { known: 60 }), pc(7, says([phone], { account: "TEST-ONLY-other" }))])).toEqual({ pin: false, why: "no_answer", waits: true, wait: null });
    expect(ask([pc(1, says([[phone, { wall: 3600, ran: 3600 }]])), pc(2, says([[phone, { wall: DAY, ran: 60 }]]))])).toEqual({ pin: false, why: "first_signer_new", waits: true, wait: DAY - 3600 });
  });

  test("a list the account service started itself is refused by every device it shows it to, and said so", async () => {
    // Its own key, carrying the person's real devices so that everything looks as before.
    const forged = await migrated(stranger, plan([phone, tablet]));
    const ask = (pcs: readonly KnownPc[]) => joinVerdict(forged.state, keys(tablet), pcs);
    expect(ask([pc(1, says([phone, tablet]))])).toEqual({ pin: false, why: "first_signer_unknown", waits: false, wait: null });
    // One PC it planted its key on a month ago says yes; another PC of the person's does not know that key: every PC must agree.
    expect(joinWord(ask([pc(1, says([phone, tablet, stranger])), pc(2, says([phone, tablet]))]))).toBe("first_signer_unknown");
    // Planted everywhere an hour ago: the device waits. What is left: planted everywhere for a day, it follows.
    expect(joinWord(ask([pc(1, says([phone, tablet, [stranger, { wall: 3600, ran: 3600 }]]))]))).toBe("first_signer_new");
    expect(joinWord(ask([pc(1, says([phone, tablet, stranger]))]))).toBe("pin");
    // A PC that is pinned to another list, or holds a removal against whoever started this one.
    const real = await migrated(phone, plan([tablet]));
    expect(joinVerdict(real.state, keys(tablet), [pc(1, says([phone])), pc(2, says([], { pinned: forged.list }))])).toEqual({ pin: false, why: "other_list", waits: false, wait: null });
    expect(joinWord(joinVerdict(real.state, keys(tablet), [pc(1, says([phone], { removed: [phone.signIn.key] }))]))).toBe("first_signer_removed");
    expect(joinWord(joinVerdict(real.state, keys(tablet), [pc(1, says([phone], { removed: [phone.member.key] }))]))).toBe("first_signer_removed");
    // One PC that holds the removal is enough, whatever the others say.
    expect(joinWord(joinVerdict(real.state, keys(tablet), [pc(1, says([phone])), pc(2, says([phone], { removed: [phone.signIn.key] }))]))).toBe("first_signer_removed");
  });

  test("it is asked only of a device that was carried in, and of a list this build can place", async () => {
    const made = await migrated(phone, plan([tablet]));
    const pcs = [pc(1, says([phone, tablet]))];
    expect([joinWord(joinVerdict(made.state, keys(laptop), pcs)), joinWord(joinVerdict(made.state, keys(phone), pcs)), joinWord(joinVerdict({ ...made.state, needs_replay: { seq: 1, hash: "00".repeat(32) } }, keys(tablet), pcs))])
      .toEqual(["not_carried", "not_carried", "stopped"]);
    // The first signer's sign-in has changed since and the PC is not pinned yet: the PC no longer holds that key, and the device asks to be let in instead.
    expect(joinWord(joinVerdict(made.state, keys(tablet), [pc(1, says([await signedInAgain(phone), tablet]))]))).toBe("first_signer_unknown");
  });
});

describe("a device names its list to a PC inside its session", () => {
  test("what it says is its member key's word, bound to that PC and to the key the session is signed in with", async () => {
    const made = await migrated(phone, plan([tablet]));
    const signed = await signNaming(made.state, { member: phone.member, session: phone.signIn.key, endpoint: E(1) });
    if (signed === null) throw new Error("nothing to name");
    expect(signed).toMatchObject({ list: made.list, key: phone.member.key });
    expect(new TextDecoder().decode(namingBytes({ account: ACCOUNT, list: made.list, key: phone.member.key, session: phone.signIn.key, endpoint: E(1) })).startsWith(LIST_NAMING_PREFIX)).toBe(true);
    expect(await heldNaming(ACCOUNT, E(1), phone.signIn.key, signed)).toEqual({ list: made.list, key: phone.member.key, session: phone.signIn.key });
    // Said to another PC, in another session, for another account, with a changed signature or list: it does not hold.
    const changed = { ...signed, signature: `${signed.signature.startsWith("A") ? "B" : "A"}${signed.signature.slice(1)}` };
    expect([await heldNaming(ACCOUNT, E(2), phone.signIn.key, signed), await heldNaming(ACCOUNT, E(1), tablet.signIn.key, signed), await heldNaming("TEST-ONLY-other", E(1), phone.signIn.key, signed),
      await heldNaming(ACCOUNT, E(1), phone.signIn.key, changed), await heldNaming(ACCOUNT, E(1), phone.signIn.key, { ...signed, list: "00".repeat(32) })]).toEqual([null, null, null, null, null]);
    // Whatever is handed over is read without a throw.
    const junk = [null, "naming", 5, { ...signed, signature: 5 }, { ...signed, signature: signed.signature.slice(1) }, { ...signed, key: offCurve }, { ...signed, key: 7 }, { ...signed, list: 3 }] as unknown as SignedNaming[];
    for (const odd of junk) expect(await heldNaming(ACCOUNT, E(1), phone.signIn.key, odd)).toBeNull();
    expect([await heldNaming(ACCOUNT, "not-a-relay-key", phone.signIn.key, signed), await heldNaming(ACCOUNT, E(1), offCurve, signed), await heldNaming("a b", E(1), phone.signIn.key, signed)]).toEqual([null, null, null]);
    for (const change of [{ account: "" }, { account: 5 }, { list: "00" }, { key: offCurve }, { session: "x" }, { session: null }, { endpoint: "E" }, { endpoint: 1 }]) {
      expect(() => namingBytes({ account: ACCOUNT, list: made.list, key: phone.member.key, session: phone.signIn.key, endpoint: E(1), ...change } as Parameters<typeof namingBytes>[0])).toThrow();
    }
    // A device names only the list it is a full member of: not one it was carried into and has not handed over in, not one it is out of.
    const out = await signListEntry(made.state, { kind: "remove", ends: phone.member.key }, phone.member, T0 + 60);
    expect([await signNaming(made.state, { member: tablet.member, session: tablet.signIn.key, endpoint: E(1) }), await signNaming(out.state, { member: phone.member, session: phone.signIn.key, endpoint: E(1) }),
      await signNaming({ ...made.state, needs_replay: { seq: 1, hash: "00".repeat(32) } }, { member: phone.member, session: phone.signIn.key, endpoint: E(1) })]).toEqual([null, null, null]);
    // A carried device that has not handed over names the list by the key it is in by, which is the session's own.
    const own = await signNaming(made.state, { member: tablet.signIn, session: tablet.signIn.key, endpoint: E(1) });
    expect(own === null ? null : await heldNaming(ACCOUNT, E(1), tablet.signIn.key, own)).toEqual({ list: made.list, key: tablet.signIn.key, session: tablet.signIn.key });
  });
});

describe("what a PC checks before it follows the list a device named", () => {
  test("it follows when the session's key is one it has let in for a day, and the list holds the device as a full device", async () => {
    const made = await migrated(phone, plan([tablet, laptop], [1]));
    const naming = await named(made.state, phone, phone.signIn.key);
    expect(pinVerdict(made.state, naming, witness([phone]))).toEqual({ pin: true, admitted: [phone.signIn.key, tablet.signIn.key, laptop.signIn.key].sort() });
    // What else the PC lets in, or does not, is no part of it: no carried key is asked of the PC.
    expect(pinWord(pinVerdict(made.state, naming, witness([phone, stranger])))).toBe("pin");
    // A carried device that runs the old app names nothing; one that has not handed over yet names the list by its sign-in key.
    expect(pinWord(pinVerdict(made.state, await named(made.state, { ...tablet, member: tablet.signIn }, tablet.signIn.key), witness([tablet])))).toBe("pin");
  });

  test("a PC that was off, or took the release weeks after the move, follows the next time a device it knows opens it: no person, no record of what it dropped", async () => {
    const made = await migrated(phone, plan([tablet, laptop], [1]));
    // A month on: the tablet handed over and signed in again; the laptop was removed; the phone that started the list was replaced and removed.
    const rotated = await signRotation(made.state, tablet, T0 + DAY, null);
    const gone = await signListEntry(rotated.state, { kind: "remove", ends: laptop.signIn.key }, tablet.member, T0 + 2 * DAY);
    const state = (await signListEntry(gone.state, { kind: "remove", ends: phone.member.key }, tablet.member, T0 + 3 * DAY)).state;
    const tabletNow = await signedInAgain(tablet);
    // The PC's rows are today's sign-ins: it never held any key the list was born with.
    const naming = await named(state, tabletNow, tabletNow.signIn.key);
    expect(pinVerdict(state, naming, witness([tabletNow]))).toMatchObject({ pin: true });
    expect([phone, tablet, laptop].map((one) => heldBy(state, one.signIn.key))).toEqual([null, tablet.member.key, null]);
    // A pairing made at the PC counts: the session is signed in with the account key itself.
    expect(pinWord(pinVerdict(state, await named(state, tablet, tablet.member.key), witness([{ key: tablet.member.key, ...OLD }])))).toBe("pin");
  });

  test("the breached service: its own genesis, a planted key under a day, a planted key over a day", async () => {
    const forged = await migrated(stranger, plan([phone, tablet]));
    // Its own genesis, named by nobody the PC lets in: there is no session to say it in, and the PC reads no list on the service's word.
    const naming = await named(forged.state, stranger, stranger.signIn.key);
    expect(pinVerdict(forged.state, naming, witness([phone, tablet]))).toEqual({ pin: false, why: "session_unknown", waits: false, wait: null });
    // It plants its key in the snapshot, so the PC lets it in: for an hour, the PC waits out the day and says nothing.
    expect(pinVerdict(forged.state, naming, witness([phone, tablet, [stranger, { wall: 3600, ran: 3600 }]]))).toEqual({ pin: false, why: "session_new", waits: true, wait: DAY - 3600 });
    // What is left, said plainly: a key the PC has let in for a day names a list to it.
    expect(pinWord(pinVerdict(forged.state, naming, witness([phone, tablet, stranger])))).toBe("pin");
    // It cannot borrow a session: a naming made for the phone's session does not hold in the stranger's, and the other way round.
    const honest = await migrated(phone, plan([tablet]));
    const borrowed = await signNaming(forged.state, { member: stranger.member, session: phone.signIn.key, endpoint: E(1) });
    expect(borrowed === null ? null : await heldNaming(ACCOUNT, E(1), stranger.signIn.key, borrowed)).toBeNull();
    // And a device the PC knows, saying a list it is not a full member of, names nothing.
    const wrong = { ...(await named(honest.state, phone, phone.signIn.key)), list: forged.list };
    expect(pinWord(pinVerdict(forged.state, wrong, witness([phone])))).toBe("not_member");
  });

  test("a key the PC let in once and dropped names nothing: it opens no session", async () => {
    // The tablet was signed out a month ago with no removal; whoever holds its old key starts a list with it.
    const forged = await migrated(tablet, plan([phone]));
    const naming = await named(forged.state, tablet, tablet.signIn.key);
    expect(pinWord(pinVerdict(forged.state, naming, witness([phone, laptop])))).toBe("session_unknown");
  });

  test("the refusals, the first that applies", async () => {
    const made = await migrated(phone, plan([tablet]));
    const naming = await named(made.state, phone, phone.signIn.key);
    const no = (why: PinRefusal, waits = false, wait: number | null = null) => ({ pin: false, why, waits, wait });
    expect(pinVerdict({ ...made.state, needs_replay: { seq: 2, hash: "00".repeat(32) } }, naming, witness([phone]))).toEqual(no("stopped") as PinVerdict);
    expect(pinVerdict(made.state, naming, witness([phone], { account: "TEST-ONLY-other" }))).toEqual(no("other_account") as PinVerdict);
    expect(pinVerdict(made.state, { ...naming, list: "00".repeat(32) }, witness([phone]))).toEqual(no("other_list") as PinVerdict);
    // A removal this PC holds against either key of the device wins over everything it lets in.
    expect(pinVerdict(made.state, naming, witness([phone], { removed: [phone.signIn.key] }))).toEqual(no("removed") as PinVerdict);
    expect(pinVerdict(made.state, naming, witness([phone], { removed: [phone.member.key] }))).toEqual(no("removed") as PinVerdict);
    // A device that only watches, or one whose time is bound, names nothing; neither does one that is out.
    const out = await signListEntry(made.state, { kind: "remove", ends: phone.member.key }, phone.member, T0 + 60);
    expect(pinVerdict(out.state, naming, witness([phone]))).toEqual(no("not_member") as PinVerdict);
    expect(pinVerdict(made.state, { ...naming, key: stranger.member.key }, witness([phone]))).toEqual(no("not_member") as PinVerdict);
    // The beginning of a birth is no list yet.
    const shown = await replay(made.texts.slice(0, 2));
    expect(pinVerdict(shown, { list: made.list, key: phone.signIn.key, session: phone.signIn.key }, witness([phone]))).toEqual(no("run_open", true) as PinVerdict);
  });

  test("a list that carries in a key that is no point of the curve is followed by no PC", async () => {
    const sealed = sealer();
    const born = await signMigration(ACCOUNT, plan([]), phone, T0, sealed.seals);
    // The kinds read only the spelling of a carried key: built here with the kinds' writer alone, on entry 0.
    const entry0 = born.entries[0];
    if (entry0 === undefined) throw new Error("no entry 0");
    const good = await signListEntry(entry0.state, { kind: "carried", key: tablet.signIn.key, role: "drive", sealed: null }, phone.signIn, T0);
    const carried = await signListEntry(good.state, { kind: "carried", key: offCurve, role: "drive", sealed: null }, phone.signIn, T0);
    const run = await signRotation(carried.state, phone, T0, null);
    expect(listView(run.state).devices.some((row) => row.key === offCurve && row.carried)).toBe(true);
    const naming = await named(run.state, phone, phone.signIn.key);
    expect(pinVerdict(run.state, naming, witness([phone, { key: offCurve, ...OLD }]))).toEqual({ pin: false, why: "carried_off_curve", waits: false, wait: null });
    expect(standsFor(run.state, offCurve)).toBeNull();
  });

  test("two devices that start at once: the service keeps one list, and each PC follows the list its devices name", async () => {
    const [a, b] = [await migrated(phone, plan([tablet])), await migrated(tablet, plan([phone]))];
    expect(a.list === b.list).toBe(false);
    // The tablet, told that the account has the phone's list, finds itself carried in there, asks its PCs and drops its own.
    expect([devicePlace(a.state, { signIn: tablet.signIn.key, member: tablet.member.key }), joinWord(joinVerdict(a.state, { signIn: tablet.signIn.key, member: tablet.member.key }, [pc(1, says([phone, tablet]))]))]).toEqual([{ at: "carried", wait: false }, "pin"]);
    // A service that keeps both can have each named to a PC by its maker: both are the person's own devices' work.
    expect([pinWord(pinVerdict(a.state, await named(a.state, phone, phone.signIn.key), witness([phone, tablet]))), pinWord(pinVerdict(b.state, await named(b.state, tablet, tablet.signIn.key), witness([phone, tablet])))]).toEqual(["pin", "pin"]);
    // A device that asks a PC pinned to the other one refuses, and says so.
    expect(joinWord(joinVerdict(a.state, { signIn: tablet.signIn.key, member: tablet.member.key }, [pc(1, says([], { pinned: b.list }))]))).toBe("other_list");
  });
});

describe("the vectors of migrate/", () => {
  const DIR = joinPath(import.meta.dir, "account-list-vectors", "migrate");
  interface Vector {
    readonly name: string;
    readonly keys: Readonly<Record<string, { readonly pkcs8: string; readonly spki: string }>>;
    readonly pc?: { readonly entries: readonly string[]; readonly endpoint: string; readonly session: string; readonly naming: SignedNaming; readonly witness: PcWitness; readonly expect: PinVerdict };
    readonly device?: { readonly known: MigrationKnown; readonly expect: MigrationStart };
    readonly join?: { readonly entries: readonly string[]; readonly keys: { readonly signIn: string; readonly member: string }; readonly pcs: readonly KnownPc[]; readonly expect: JoinVerdict };
  }
  const vectors = readdirSync(DIR).filter((file) => file.endsWith(".json")).sort().map((file) => JSON.parse(readFileSync(joinPath(DIR, file), "utf8")) as Vector);
  const state = async (entries: readonly string[]) => {
    const replayed = await replayList(entries, LIST_LEVEL, { saved: null });
    if (replayed.member === null) throw new Error("the vector's list does not replay");
    return replayed.member.state;
  };

  test("there is a vector for each answer a PC, a first device and a carried device can give", () => {
    const of = (words: readonly string[]) => new Set(words);
    const pcs = of(vectors.flatMap((vector) => (vector.pc === undefined ? [] : [pinWord(vector.pc.expect)])));
    expect(["pin", "other_account", "other_list", "carried_off_curve", "removed", "session_unknown", "session_new", "not_member", "run_open"].filter((word) => !pcs.has(word))).toEqual([]);
    const starts = of(vectors.flatMap((vector) => (vector.device === undefined ? [] : [vector.device.expect.start ? "start" : vector.device.expect.why])));
    expect(["start", "self_unlisted", "self_removed", "no_witness", "self_unwitnessed", "too_new"].filter((word) => !starts.has(word))).toEqual([]);
    const joins = of(vectors.flatMap((vector) => (vector.join === undefined ? [] : [joinWord(vector.join.expect)])));
    expect(["pin", "run_open", "not_carried", "no_answer", "other_list", "first_signer_removed", "first_signer_unknown", "first_signer_new"].filter((word) => !joins.has(word))).toEqual([]);
    for (const vector of vectors) expect(Object.keys(vector.keys).every((name) => name.startsWith("TEST-ONLY-"))).toBe(true);
  });

  for (const vector of vectors) {
    test(`migrate/${vector.name}`, async () => {
      if (vector.pc !== undefined) {
        const held = await heldNaming(vector.pc.witness.account, vector.pc.endpoint, vector.pc.session, vector.pc.naming);
        if (held === null) throw new Error("the vector's naming does not hold");
        expect(pinVerdict(await state(vector.pc.entries), held, vector.pc.witness)).toEqual(vector.pc.expect);
      }
      if (vector.device !== undefined) expect(migrationPlan(vector.device.known)).toEqual(vector.device.expect);
      if (vector.join !== undefined) expect(joinVerdict(await state(vector.join.entries), vector.join.keys, vector.join.pcs)).toEqual(vector.join.expect);
    });
  }
});
