import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import {
  LIST_LEVEL, admitsDevice, holdsPc, listView, namesFields, readNames, replayList, sealEpoch, signCard, signListEntries, signListEntry,
  type ListNames, type ListSigner, type ListState,
} from "./account-list.ts";
import { epochKeyCommitment, newEpochKey, nextEpoch, openSealed, sealFields, type EpochKey } from "./account-list-seal.ts";
import {
  LIST_VOUCH_PREFIX, MIGRATION_CARRIED_MAX, MIGRATION_REQUEST_ENTRIES, MIGRATION_RUN_SECONDS, MIGRATION_WITNESS_SECONDS, MigrationError, devicePlace, heirOf, heldVouches, migrationPlan,
  migrationRequests, migrationVerdict, ownEvidence, rekeys, signMigrationGenesis, signMigrationRun, signRotation, signVouch, standsFor, vouchBytes,
  type KnownDevice, type KnownPc, type MigratingDevice, type MigrationKnown, type MigrationPlan, type MigrationRefusal, type MigrationSeals, type MigrationStart, type MigrationVerdict,
  type PcWitness, type SignedVouch,
} from "./account-list-migrate.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const DAY = MIGRATION_WITNESS_SECONDS;
/** The second the first device starts the list. Every key the PCs hold has been let in since `LONG_AGO`. */
const T0 = 1767225600;
const LONG_AGO = T0 - 30 * DAY;
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
/** A key in its one spelling whose point is not on the curve: nobody holds its private half, and no entry it signed would hold. */
const offCurve = (() => {
  const bytes = fromBase64Url(tablet.signIn.key);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  return toBase64Url(bytes);
})();

/** The caller's side of sealing, with the real keys: what a device does with shared/account-list-seal.ts. */
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
const said = async (texts: readonly string[]) => (await replayList(texts, LIST_LEVEL, { saved: null })).took.slice(1).map((item) => item.outcome.outcome);

/** A list as the first device makes it: entry 0 and the whole run, with the keys that sealed its names. */
async function migrated(first: Device, carried: Pick<MigrationPlan, "devices" | "pcs">, at = T0) {
  const sealed = sealer();
  const genesis = await signMigrationGenesis(ACCOUNT, first, at, sealed.seals);
  const run = await signMigrationRun(genesis.state, carried, first, at, sealed.seals);
  const texts = [genesis.text, ...run.entries.map((entry) => entry.text)];
  return { texts, state: run.state, sealed, list: genesis.state.list };
}

/** What a PC holds: every key let in since long ago unless a test says otherwise. */
function witness(admits: readonly (Device | readonly [Device, number])[], rest: Partial<Pick<PcWitness, "removed" | "once" | "account" | "vouched">> = {}): PcWitness {
  return {
    account: rest.account ?? ACCOUNT,
    admits: admits.map((one) => ("signIn" in one ? { key: one.signIn.key, since: LONG_AGO } : { key: one[0].signIn.key, since: one[1] })),
    removed: rest.removed ?? [], once: rest.once ?? [], vouched: rest.vouched ?? [],
  };
}
/** The same device after it signed in again: another sign-in key, the same account key. */
async function signedInAgain(one: Device): Promise<Device> {
  return { ...one, signIn: await signer() };
}
const refusal = (verdict: MigrationVerdict): MigrationRefusal | "pin" => (verdict.pin ? "pin" : verdict.why);

const listed = (one: Device, eligible = true): KnownDevice => ({ key: one.signIn.key, eligible, names: one.names });
const pcSays = (n: number, admits: readonly (Device | readonly [Device, number])[], rest: Partial<KnownPc> & { readonly removed?: readonly string[] } = {}): KnownPc => ({
  endpoint: E(n), paired: rest.paired ?? false, since: rest.since === undefined ? LONG_AGO : rest.since, names: names(`PC ${n}`),
  says: rest.says === undefined ? { admits: witness(admits).admits, removed: rest.removed ?? [] } : rest.says,
});
const known = (devices: readonly KnownDevice[], pcs: readonly KnownPc[], removed: readonly string[] = []): MigrationKnown => ({ self: phone.signIn.key, devices, removed, pcs });
const started = (start: MigrationStart): MigrationPlan => {
  if (!start.start) throw new Error(`no start: ${start.why}`);
  return start.plan;
};

describe("whom the first device carries in", () => {
  test("a device that a PC it knows has let in for a day, and the PCs it knows by its own record", () => {
    const start = migrationPlan(known([listed(phone), listed(tablet), listed(laptop)], [pcSays(1, [phone, tablet, laptop]), pcSays(2, [phone, tablet])]), T0);
    expect(started(start)).toEqual({
      devices: [{ key: tablet.signIn.key, names: tablet.names }, { key: laptop.signIn.key, names: laptop.names }],
      pcs: [{ endpoint: E(1), names: names("PC 1") }, { endpoint: E(2), names: names("PC 2") }],
      left: { devices: [], pcs: [] },
    });
  });

  test("a key that only the account service names gets no place: it adds a key to what it tells the first device", () => {
    const start = migrationPlan(known([listed(phone), listed(tablet), listed(stranger)], [pcSays(1, [phone, tablet])]), T0);
    expect([started(start).devices.map((row) => row.key), started(start).left.devices]).toEqual([[tablet.signIn.key], [{ key: stranger.signIn.key, why: "unwitnessed" }]]);
  });

  test("a key the service planted on the PCs an hour ago holds the start back until it has been let in for a day", () => {
    const planted = T0 - 3600;
    const start = migrationPlan(known([listed(phone), listed(stranger)], [pcSays(1, [phone, [stranger, planted]])]), T0);
    expect(start).toEqual({ start: false, why: "too_new", until: planted + DAY });
    // The honest case is the same: a phone the person added this morning. Nobody presses anything; the device asks again.
    expect(started(migrationPlan(known([listed(phone), listed(stranger)], [pcSays(1, [phone, [stranger, planted]])]), planted + DAY)).devices).toHaveLength(1);
  });

  test("what is left, said plainly: a key the PCs have let in for a day is carried in, whoever put it there", () => {
    const start = migrationPlan(known([listed(phone), listed(stranger)], [pcSays(1, [phone, [stranger, T0 - DAY]])]), T0);
    expect(started(start).devices.map((row) => row.key)).toEqual([stranger.signIn.key]);
  });

  test("a device the service hides is not carried in, and nothing else changes", () => {
    const start = migrationPlan(known([listed(phone), listed(laptop)], [pcSays(1, [phone, tablet, laptop])]), T0);
    expect([started(start).devices.map((row) => row.key), started(start).left.devices]).toEqual([[laptop.signIn.key], []]);
  });

  test("a device that was removed the day before stays out, also where the service lists it again", () => {
    const removed = migrationPlan(known([listed(phone), listed(tablet, false)], [pcSays(1, [phone])], [tablet.signIn.key]), T0);
    expect(started(removed).left.devices).toEqual([{ key: tablet.signIn.key, why: "removed" }]);
    // The service lies: it lists the key as in again, and one PC that was off still lets it in. Another PC holds the removal.
    const relisted = migrationPlan(known([listed(phone), listed(tablet)], [pcSays(1, [phone, tablet]), pcSays(2, [phone], { removed: [tablet.signIn.key] })]), T0);
    expect([started(relisted).devices, started(relisted).left.devices]).toEqual([[], [{ key: tablet.signIn.key, why: "removed_at_pc" }]]);
  });

  test("a key the service says no PC lets in, and a key that is no key", () => {
    const start = migrationPlan(known([listed(phone), listed(tablet, false), { key: "no-key", eligible: true, names: null }], [pcSays(1, [phone, tablet])]), T0);
    expect(started(start).left.devices).toEqual([{ key: tablet.signIn.key, why: "not_eligible" }, { key: "no-key", why: "form" }]);
  });

  test("no list is started on the service's word alone: a PC counts only when this device knows it by its own record, and it answered", () => {
    const devices = [listed(phone), listed(tablet)];
    const none = { start: false, why: "no_witness", until: null } as const;
    expect(migrationPlan(known(devices, []), T0)).toEqual(none);
    // Only the directory names it; this device first reached it an hour ago; it runs an Ovis that cannot answer.
    expect(migrationPlan(known(devices, [pcSays(1, [phone, tablet], { since: null })]), T0)).toEqual(none);
    expect(migrationPlan(known(devices, [pcSays(1, [phone, tablet], { since: T0 - 3600 })]), T0)).toEqual(none);
    expect(migrationPlan(known(devices, [pcSays(1, [], { says: null })]), T0)).toEqual(none);
    // A PC the person paired this device with at the PC is known at once.
    expect(started(migrationPlan(known(devices, [pcSays(1, [phone, tablet], { since: null, paired: true })]), T0)).devices).toHaveLength(1);
    expect([ownEvidence({ paired: false, since: T0 - DAY }, T0), ownEvidence({ paired: false, since: T0 - DAY + 1 }, T0), ownEvidence({ paired: false, since: null }, T0)]).toEqual([true, false, false]);
  });

  test("the device's own key is held to the same", () => {
    const pcs = [pcSays(1, [tablet])];
    expect(migrationPlan(known([listed(tablet)], pcs), T0)).toEqual({ start: false, why: "self_unlisted", until: null });
    expect(migrationPlan(known([listed(phone, false)], pcs), T0)).toEqual({ start: false, why: "self_unlisted", until: null });
    expect(migrationPlan(known([listed(phone)], pcs, [phone.signIn.key]), T0)).toEqual({ start: false, why: "self_removed", until: null });
    expect(migrationPlan(known([listed(phone)], [pcSays(1, [phone], { removed: [phone.signIn.key] })]), T0)).toEqual({ start: false, why: "self_removed", until: null });
    expect(migrationPlan(known([listed(phone)], pcs), T0)).toEqual({ start: false, why: "self_unwitnessed", until: null });
    expect(migrationPlan(known([listed(phone)], [pcSays(1, [[phone, T0 - 60]])]), T0)).toEqual({ start: false, why: "too_new", until: T0 - 60 + DAY });
  });

  test("a PC is carried in by this device's own record of it, answered or not; any other is added later", () => {
    const start = migrationPlan(known([listed(phone)], [
      pcSays(1, [phone]), pcSays(2, [], { says: null }), pcSays(3, [], { says: null, since: null, paired: true }), pcSays(4, [phone], { since: T0 - 60 }), pcSays(5, [phone], { since: null }),
      { ...pcSays(6, [phone]), endpoint: "not-a-relay-key" },
    ]), T0);
    expect([started(start).pcs.map((row) => row.endpoint), started(start).left.pcs]).toEqual([
      [E(1), E(2), E(3)], [{ endpoint: E(4), why: "pc_too_new" }, { endpoint: E(5), why: "unknown_pc" }, { endpoint: "not-a-relay-key", why: "form" }],
    ]);
  });

  test("an account with more than a list carries in: the devices a PC saw in use last are kept, and the run takes several requests", async () => {
    const many = await Promise.all(Array.from({ length: MIGRATION_CARRIED_MAX + 3 }, (_, index) => device(`Device ${index}`)));
    // Device 0 was last used a year ago, Device 1 never as far as the PC knows, Device 2 a month ago; the others this week.
    const seen = (index: number): number | null => (index === 0 ? T0 - 365 * DAY : index === 1 ? null : index === 2 ? T0 - 31 * DAY : T0 - index);
    const says = { admits: [...witness([phone]).admits, ...many.map((one, index) => ({ key: one.signIn.key, since: LONG_AGO, seen: seen(index) }))], removed: [] };
    const start = started(migrationPlan(known([listed(phone), ...many.map((one) => listed(one))], [{ ...pcSays(1, []), says }, pcSays(2, [phone])]), T0));
    expect([start.devices.length, start.devices[0]?.key, start.pcs, start.left.devices.map((row) => row.key), start.left.pcs.map((row) => row.why)]).toEqual([
      MIGRATION_CARRIED_MAX, many[3]?.signIn.key, [], [many[0]?.signIn.key, many[1]?.signIn.key, many[2]?.signIn.key], ["over_limit", "over_limit"],
    ]);
    // Where all fit, nothing is reordered and nobody is asked when it was last seen.
    const few = started(migrationPlan(known([listed(phone), listed(many[0] ?? phone), listed(many[5] ?? phone)], [{ ...pcSays(1, []), says }]), T0));
    expect(few.devices.map((row) => row.key)).toEqual([many[0]?.signIn.key, many[5]?.signIn.key]);

    const sealed = sealer();
    const genesis = await signMigrationGenesis(ACCOUNT, phone, T0, sealed.seals);
    const run = await signMigrationRun(genesis.state, start, phone, T0, sealed.seals);
    const requests = migrationRequests(run.entries.map((entry) => entry.text));
    expect([run.entries.length, requests.map((request) => request.length), requests.flat()]).toEqual([MIGRATION_CARRIED_MAX + 2, [16, 16, 16, 16, 2], run.entries.map((entry) => entry.text)]);
    const state = await replay([genesis.text, ...requests.flat()]);
    expect([state.carrying, listView(state).devices.filter((row) => row.carried).length]).toEqual([false, MIGRATION_CARRIED_MAX]);
    // While only the first requests are placed, the run is open and no PC follows.
    const part = await replay([genesis.text, ...requests.slice(0, 2).flat()]);
    expect([part.carrying, refusal(migrationVerdict(part, witness([phone, ...many]), T0))]).toEqual([true, "run_open"]);
    await expect(signMigrationRun(genesis.state, { devices: [...start.devices, { key: many[0]?.signIn.key ?? "", names: null }], pcs: [] }, phone, T0, sealed.seals)).rejects.toMatchObject({ code: "too_many" });
  });

  test("requests hold sixteen entries at most, and the hand-over is never parted from the epoch entry after it", () => {
    const sizes = (count: number) => migrationRequests(Array.from({ length: count }, (_, index) => index)).map((request) => request.length);
    expect([MIGRATION_REQUEST_ENTRIES, sizes(0), sizes(1), sizes(2), sizes(16), sizes(17), sizes(18), sizes(33), sizes(66)]).toEqual([16, [], [1], [2], [16], [15, 2], [16, 2], [16, 15, 2], [16, 16, 16, 16, 2]]);
    expect(migrationRequests([1, 2, 3]).flat()).toEqual([1, 2, 3]);
  });
});

describe("the entries of a list that carries an account in", () => {
  test("entry 0 by the sign-in key, the run, the hand-over to the member key, the next epoch: every entry counts", async () => {
    const made = await migrated(phone, plan([tablet, laptop], [1, 2]));
    expect(await said(made.texts)).toEqual(["counts", "counts", "counts", "counts", "counts", "counts"]);
    const state = await replay(made.texts);
    expect(state).toEqual(made.state);
    const view = listView(state);
    expect(view.devices.map((row) => [row.key, row.carried, row.ended, row.enc])).toEqual([
      [phone.signIn.key, false, 5, phone.enc], [tablet.signIn.key, true, null, null], [laptop.signIn.key, true, null, null], [phone.member.key, false, null, phone.enc],
    ]);
    expect(view.pcs.map((row) => [row.endpoint, row.how, row.key])).toEqual([[E(1), "carried", null], [E(2), "carried", null]]);
    expect([state.account, state.carrying, state.epoch, view.signers]).toEqual([ACCOUNT, false, 1, []]);
    // The PCs let the old apps in by the keys they hold today, and the first device by the key it goes on with.
    expect([phone.signIn, tablet.signIn, laptop.signIn, phone.member, stranger.signIn].map((one) => admitsDevice(state, one.key, T0))).toEqual([null, "drive", "drive", "drive", null]);
    expect([holdsPc(state, E(1)), holdsPc(state, E(3))]).toEqual([true, false]);
    // Names go on being sealed, under an epoch whose key the sign-in key never held; it is wrapped to the one key that can open it.
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

  test("a request of which only the beginning was placed is taken up from what the log shows", async () => {
    const sealed = sealer();
    const genesis = await signMigrationGenesis(ACCOUNT, phone, T0, sealed.seals);
    const whole = plan([tablet, laptop], [1]);
    const first = await signMigrationRun(genesis.state, whole, phone, T0, sealed.seals);
    // A lying service places entry 0 and the first carried entry, and no more.
    const shown = [genesis.text, first.entries[0]?.text ?? ""];
    const rest = await signMigrationRun(await replay(shown), whole, phone, T0 + 60, sealed.seals);
    const texts = [...shown, ...rest.entries.map((entry) => entry.text)];
    expect([rest.entries.length, await said(texts)]).toEqual([4, ["counts", "counts", "counts", "counts", "counts"]]);
    const state = await replay(texts);
    expect([state.carrying, listView(state).devices.filter((row) => row.carried).map((row) => row.key), holdsPc(state, E(1))]).toEqual([false, [tablet.signIn.key, laptop.signIn.key], true]);
    // Asked again once all is placed, it writes nothing.
    expect((await signMigrationRun(state, whole, phone, T0 + 120, sealed.seals)).entries).toEqual([]);
  });

  test("a carried key that is no point of the curve is never signed: the whole run is refused before any entry of it", async () => {
    const sealed = sealer();
    const genesis = await signMigrationGenesis(ACCOUNT, phone, T0, sealed.seals);
    const bad = { devices: [{ key: tablet.signIn.key, names: tablet.names }, { key: offCurve, names: null }], pcs: [] };
    await expect(signMigrationRun(genesis.state, bad, phone, T0, sealed.seals)).rejects.toMatchObject({ code: "key_invalid" });
    await expect(signMigrationRun(genesis.state, { devices: [], pcs: [{ endpoint: "not-a-relay-key", names: null }] }, phone, T0, sealed.seals)).rejects.toMatchObject({ code: "key_invalid" });
    // Nothing was sealed or opened for it either.
    expect(sealed.wrapped).toEqual([]);
    // The plan never names one: what the account service lists with such a key is left out.
    const start = migrationPlan(known([listed(phone), { key: offCurve, eligible: true, names: null }], [{ ...pcSays(1, [phone]), says: { admits: [...witness([phone]).admits, { key: offCurve, since: LONG_AGO }], removed: [] } }]), T0);
    expect([started(start).devices, started(start).left.devices]).toEqual([[], [{ key: offCurve, why: "form" }]]);
  });

  test("only the device that signed entry 0 writes the run, and only while one of its keys is in", async () => {
    const made = await migrated(phone, plan([tablet]));
    const code = async (run: () => Promise<unknown>) => await run().then(() => null, (error: unknown) => (error instanceof MigrationError ? error.code : String(error)));
    expect(await code(() => signMigrationRun(made.state, plan([laptop]), tablet, T0, sealer().seals))).toBe("not_first");
    expect(await code(() => signMigrationRun({ ...made.state, needs_replay: { seq: 3, hash: "00".repeat(32) } }, plan([]), phone, T0, sealer().seals))).toBe("stopped");
    // The tablet hands its place on and removes the first device.
    const rotated = await signRotation(made.state, tablet, T0 + 60, null, T0 + 60);
    const removed = await signListEntry(rotated.state, { kind: "remove", ends: phone.member.key }, tablet.member, T0 + 60);
    expect(await code(() => signMigrationRun(removed.state, plan([]), phone, T0 + 120, sealer().seals))).toBe("not_in");
  });
});

describe("a device that was signed in before the list", () => {
  test("it learns from the list that it was carried in, and hands its place to its member key once the run is over", async () => {
    const sealed = sealer();
    const genesis = await signMigrationGenesis(ACCOUNT, phone, T0, sealed.seals);
    const run = await signMigrationRun(genesis.state, plan([tablet, laptop]), phone, T0, sealed.seals);
    const open = await replay([genesis.text, run.entries[0]?.text ?? ""]);
    const keys = (one: Device) => ({ signIn: one.signIn.key, member: one.member.key });
    // While the first device is still carrying, the tablet writes nothing: its entry would end the run and leave the laptop outside.
    expect([devicePlace(open, keys(tablet), T0 + 30), devicePlace(open, keys(phone), T0 + 30), devicePlace(open, keys(laptop), T0 + 30)]).toEqual([{ at: "carried", wait: true }, { at: "first" }, { at: "absent" }]);
    await expect(signRotation(open, tablet, T0 + 30, null, T0 + 30)).rejects.toMatchObject({ code: "run_open" });

    const closed = run.state;
    expect([devicePlace(closed, keys(tablet), T0 + 30), devicePlace(closed, keys(phone), T0 + 30), devicePlace(closed, keys(stranger), T0 + 30)]).toEqual([{ at: "carried", wait: false }, { at: "member" }, { at: "absent" }]);
    const rotated = await signRotation(closed, tablet, T0 + 30, null, T0 + 30);
    const state = await replay([genesis.text, ...run.entries.map((entry) => entry.text), rotated.text]);
    expect(state).toEqual(rotated.state);
    expect([devicePlace(state, keys(tablet), T0 + 60), admitsDevice(state, tablet.signIn.key, T0 + 60), admitsDevice(state, tablet.member.key, T0 + 60)]).toEqual([{ at: "member" }, null, "drive"]);
    expect(listView(state).devices.find((row) => row.key === tablet.member.key)).toMatchObject({ by: tablet.signIn.key, carried: false, enc: tablet.enc, power: "full" });
    // A PC moves the row; it is the same device. The laptop, which has not run the new app, stays where it was.
    expect(rekeys(closed, state)).toEqual([{ from: tablet.signIn.key, to: tablet.member.key }]);
    expect([heirOf(state, tablet.signIn.key), heirOf(state, laptop.signIn.key), standsFor(state, phone.signIn.key), standsFor(state, laptop.signIn.key), standsFor(state, stranger.signIn.key)])
      .toEqual([tablet.member.key, null, phone.member.key, laptop.signIn.key, null]);
    // A PC that pins this list reads the same from it for the rows it kept by sign-in keys.
    expect(rekeys(genesis.state, state)).toEqual([{ from: phone.signIn.key, to: phone.member.key }]);
    await expect(signRotation(state, tablet, T0 + 90, null, T0 + 90)).rejects.toMatchObject({ code: "not_in" });
  });

  test("a run the first device gave up is ended by a carried device after ten minutes, and nobody is carried in after it", async () => {
    const sealed = sealer();
    const genesis = await signMigrationGenesis(ACCOUNT, phone, T0, sealed.seals);
    const run = await signMigrationRun(genesis.state, plan([tablet, laptop]), phone, T0, sealed.seals);
    const shown = [genesis.text, run.entries[0]?.text ?? ""];
    const open = await replay(shown);
    await expect(signRotation(open, tablet, T0 + MIGRATION_RUN_SECONDS - 1, null, T0 + MIGRATION_RUN_SECONDS - 1)).rejects.toMatchObject({ code: "run_open" });
    expect(devicePlace(open, { signIn: tablet.signIn.key, member: tablet.member.key }, T0 + MIGRATION_RUN_SECONDS)).toEqual({ at: "carried", wait: false });
    const rotated = await signRotation(open, tablet, T0 + MIGRATION_RUN_SECONDS, null, T0 + MIGRATION_RUN_SECONDS);
    expect(rotated.state.carrying).toBe(false);
    // The first device comes back: it hands its own place on, and the laptop is left to ask as a new device does.
    const rest = await signMigrationRun(rotated.state, plan([tablet, laptop]), phone, T0 + 900, sealed.seals);
    const state = await replay([...shown, rotated.text, ...rest.entries.map((entry) => entry.text)]);
    expect([rest.entries.length, devicePlace(state, { signIn: laptop.signIn.key, member: laptop.member.key }, T0 + 900), admitsDevice(state, phone.member.key, T0 + 900)]).toEqual([2, { at: "absent" }, "drive"]);
  });

  test("a device that was removed is out, whichever of its keys the removal named", async () => {
    const made = await migrated(phone, plan([tablet, laptop]));
    const keys = (one: Device) => ({ signIn: one.signIn.key, member: one.member.key });
    const removed = await signListEntries(made.state, [{ kind: "remove", ends: laptop.signIn.key }], phone.member, T0 + 60);
    expect(devicePlace(removed.state, keys(laptop), T0 + 60)).toEqual({ at: "out" });
    const rotated = await signRotation(made.state, tablet, T0 + 60, null, T0 + 60);
    const out = await signListEntry(rotated.state, { kind: "remove", ends: tablet.member.key }, phone.member, T0 + 90);
    expect([devicePlace(out.state, keys(tablet), T0 + 90), standsFor(out.state, tablet.signIn.key), rekeys(rotated.state, out.state)]).toEqual([{ at: "out" }, null, []]);
  });
});

describe("what a PC checks before it follows a list that carries its account in", () => {
  test("it follows when it let in, itself, the key that started the list and every key that was carried in", async () => {
    const made = await migrated(phone, plan([tablet, laptop], [1]));
    expect(migrationVerdict(made.state, witness([phone, tablet, laptop]), T0)).toEqual({ pin: true, admitted: [phone.signIn.key, tablet.signIn.key, laptop.signIn.key].sort() });
    // What else the PC lets in is its own business: a device the service hid from the first device changes nothing here.
    expect(refusal(migrationVerdict(made.state, witness([phone, tablet, laptop, stranger]), T0))).toBe("pin");
  });

  test("all or nothing: one carried key the PC never let in, and it follows nothing of the list", async () => {
    const made = await migrated(phone, plan([tablet, stranger]));
    expect(migrationVerdict(made.state, witness([phone, tablet]), T0)).toEqual({ pin: false, why: "carried_unknown", keys: [stranger.signIn.key], waits: false, until: null });
    // The person says "Not me" on the one-time notice: the stranger is out, it left nobody in, and the PC follows by itself.
    const removed = await signListEntry(made.state, { kind: "remove", ends: stranger.signIn.key }, phone.member, T0 + 60);
    expect(refusal(migrationVerdict(removed.state, witness([phone, tablet]), T0 + 60))).toBe("pin");
  });

  test("a list the account service started itself is followed by no PC", async () => {
    // Its own key, which no PC ever let in, carrying the person's real devices so that everything looks as before.
    const forged = await migrated(stranger, plan([phone, tablet]));
    expect(migrationVerdict(forged.state, witness([phone, tablet]), T0)).toEqual({ pin: false, why: "first_signer_unknown", keys: [stranger.signIn.key], waits: false, until: null });
    // It plants its key in what it tells the PC first: the PC has let it in for an hour, not a day.
    const planted = T0 - 3600;
    expect(migrationVerdict(forged.state, witness([phone, tablet, [stranger, planted]]), T0)).toEqual({ pin: false, why: "first_signer_new", keys: [stranger.signIn.key], waits: true, until: planted + DAY });
    const carriedIn = await migrated(phone, plan([tablet, stranger]));
    expect(migrationVerdict(carriedIn.state, witness([phone, tablet, [stranger, planted]]), T0)).toEqual({ pin: false, why: "carried_new", keys: [stranger.signIn.key], waits: true, until: planted + DAY });
    // What is left, said plainly: a key the PC has let in for a day is a key of the account to it.
    expect(refusal(migrationVerdict(forged.state, witness([phone, tablet, [stranger, T0 - DAY]]), T0))).toBe("pin");
  });

  test("a list that carries in a key that is no point of the curve is followed by no PC, whatever the PC holds of that key", async () => {
    const sealed = sealer();
    const genesis = await signMigrationGenesis(ACCOUNT, phone, T0, sealed.seals);
    // The kinds read only the spelling of a carried key, so a first device that signs with the kinds' writer alone can carry one in.
    const carried = await signListEntry(genesis.state, { kind: "carried", key: offCurve, role: "drive", sealed: null }, phone.signIn, T0);
    const run = await signMigrationRun(carried.state, plan([tablet]), phone, T0, sealed.seals);
    expect(listView(run.state).devices.some((row) => row.key === offCurve && row.carried)).toBe(true);
    const holds: PcWitness = { account: ACCOUNT, admits: [...witness([phone, tablet]).admits, { key: offCurve, since: LONG_AGO }], removed: [], once: [], vouched: [] };
    expect(migrationVerdict(run.state, holds, T0)).toEqual({ pin: false, why: "carried_off_curve", keys: [offCurve], waits: false, until: null });
    // Before any question of who is let in, and also while the run is open.
    expect(refusal(migrationVerdict(run.state, { ...holds, removed: [tablet.signIn.key] }, T0))).toBe("carried_off_curve");
    expect(refusal(migrationVerdict(carried.state, holds, T0))).toBe("carried_off_curve");
    // Nor is such a key ever what a row moves to, or what the pin names.
    expect(standsFor(run.state, offCurve)).toBeNull();
  });

  test("a removal this PC holds wins over the list: a device removed the day before, which the service lists again", async () => {
    const made = await migrated(phone, plan([tablet, laptop]));
    expect(migrationVerdict(made.state, witness([phone, tablet], { removed: [laptop.signIn.key] }), T0)).toEqual({ pin: false, why: "carried_removed", keys: [laptop.signIn.key], waits: false, until: null });
    // Whatever else the PC holds of the key.
    expect(refusal(migrationVerdict(made.state, witness([phone, tablet, laptop], { removed: [laptop.signIn.key], once: [laptop.signIn.key] }), T0))).toBe("carried_removed");
    expect(refusal(migrationVerdict(made.state, witness([tablet, laptop], { removed: [phone.signIn.key] }), T0))).toBe("first_signer_removed");
  });

  test("while the list may still carry more in, the PC waits: a service that shows only the beginning gets no pin for it", async () => {
    const sealed = sealer();
    const genesis = await signMigrationGenesis(ACCOUNT, phone, T0, sealed.seals);
    const run = await signMigrationRun(genesis.state, plan([tablet, stranger]), phone, T0, sealed.seals);
    // Entry 0 and the tablet: every key so far is one the PC lets in. The stranger's entry is held back.
    const prefix = await replay([genesis.text, run.entries[0]?.text ?? ""]);
    expect(migrationVerdict(prefix, witness([phone, tablet]), T0)).toEqual({ pin: false, why: "run_open", keys: [], waits: true, until: null });
    expect(refusal(migrationVerdict(genesis.state, witness([phone, tablet]), T0))).toBe("run_open");
    expect(refusal(migrationVerdict(run.state, witness([phone, tablet]), T0))).toBe("carried_unknown");
  });

  test("a PC that was off for a month follows the list when it comes back, by what it held of each key", async () => {
    const made = await migrated(phone, plan([tablet, laptop], [1]));
    // Meanwhile the tablet ran the new app and handed its place on; the laptop was signed out and removed in the list.
    const rotated = await signRotation(made.state, tablet, T0 + DAY, null, T0 + DAY);
    const removed = await signListEntries(rotated.state, [{ kind: "remove", ends: laptop.signIn.key }], phone.member, T0 + 2 * DAY);
    const later = T0 + 30 * DAY;
    // The PC's first whole read on its return: the tablet's sign-in is still listed, the laptop's is gone, with no removal.
    const back = witness([phone, tablet], { once: [laptop.signIn.key] });
    expect(refusal(migrationVerdict(removed.state, back, later))).toBe("pin");
    // The rows it kept by sign-in keys move to the keys the same devices are in by now.
    expect([phone, tablet, laptop].map((one) => standsFor(removed.state, one.signIn.key))).toEqual([phone.member.key, tablet.member.key, null]);
    // A service that withholds the removal shows the laptop as still in: the PC had stopped letting it in, and does not follow.
    expect(migrationVerdict(rotated.state, back, later)).toEqual({ pin: false, why: "carried_dropped", keys: [laptop.signIn.key], waits: false, until: null });
    // A PC that keeps no record of what it dropped follows too: the laptop is out of the list and left nobody in.
    expect(refusal(migrationVerdict(removed.state, witness([phone, tablet]), later))).toBe("pin");
    // And one that dropped the first device's sign-in key, which has handed its place on since, follows.
    expect(refusal(migrationVerdict(removed.state, witness([tablet], { once: [phone.signIn.key, laptop.signIn.key] }), later))).toBe("pin");
    expect(refusal(migrationVerdict(made.state, witness([tablet, laptop], { once: [phone.signIn.key] }), later))).toBe("pin");
    const unrotated = await signMigrationGenesis(ACCOUNT, phone, T0, sealer().seals);
    expect(refusal(migrationVerdict(unrotated.state, witness([tablet], { once: [phone.signIn.key] }), later))).toBe("first_signer_dropped");
  });

  test("an old migration shown to a PC later gets nothing it would not get today", async () => {
    const made = await migrated(phone, plan([tablet], [1]));
    // After Revoke all at the PC it lets nobody in: the list that carried the account in names keys it no longer holds.
    expect(refusal(migrationVerdict(made.state, witness([]), T0 + 60 * DAY))).toBe("first_signer_unknown");
    // A PC that moved to another account.
    expect(migrationVerdict(made.state, witness([phone, tablet], { account: "TEST-ONLY-other" }), T0)).toEqual({ pin: false, why: "other_account", keys: [], waits: false, until: null });
    expect(refusal(migrationVerdict({ ...made.state, needs_replay: { seq: 2, hash: "00".repeat(32) } }, witness([phone, tablet]), T0))).toBe("stopped");
  });

  test("two devices that start at once: a PC cannot tell their lists apart, and each device knows which one is its own", async () => {
    const [a, b] = [await migrated(phone, plan([tablet])), await migrated(tablet, plan([phone]))];
    const pc = witness([phone, tablet]);
    // The account service keeps one list for an account. One that keeps both can show each PC one of them: both are the
    // person's own devices' work, and nobody is in either who was not in before.
    expect([refusal(migrationVerdict(a.state, pc, T0)), refusal(migrationVerdict(b.state, pc, T0)), a.list === b.list]).toEqual(["pin", "pin", false]);
    expect([migrationVerdict(a.state, pc, T0), migrationVerdict(b.state, pc, T0)].map((verdict) => (verdict.pin ? verdict.admitted : []))).toEqual([[phone.signIn.key, tablet.signIn.key].sort(), [phone.signIn.key, tablet.signIn.key].sort()]);
    // The tablet, told that the account has the phone's list, finds itself carried in there and drops its own.
    expect(devicePlace(a.state, { signIn: tablet.signIn.key, member: tablet.member.key }, T0 + 30)).toEqual({ at: "carried", wait: false });
  });

  test("a list with no carried device: the PC still asks who started it", async () => {
    const made = await migrated(phone, plan([], [1]));
    expect([refusal(migrationVerdict(made.state, witness([phone]), T0)), refusal(migrationVerdict(made.state, witness([tablet]), T0))]).toEqual(["pin", "first_signer_unknown"]);
  });
});

describe("a PC that holds no record of a key: it took this release after its account moved, or was off", () => {
  /** The account a month on: the tablet handed its place on and has signed in again since; the laptop still runs the app from before the list. */
  async function monthOn() {
    const made = await migrated(phone, plan([tablet, laptop], [1]));
    const rotated = await signRotation(made.state, tablet, T0 + DAY, null, T0 + DAY);
    const tabletNow = await signedInAgain(tablet);
    const vouch = await signVouch(rotated.state, tabletNow);
    if (vouch === null) throw new Error("no vouch");
    return { made, state: rotated.state, tabletNow, vouch, later: T0 + 30 * DAY };
  }

  test("a vouch is the word of the sign-in key: only the device that holds it can say which member key is its own", async () => {
    const { state, tabletNow, vouch } = await monthOn();
    expect(vouch).toMatchObject({ key: tablet.member.key, device: tabletNow.signIn.key });
    expect(new TextDecoder().decode(vouchBytes({ account: ACCOUNT, list: state.list, key: vouch.key, device: vouch.device })).startsWith(LIST_VOUCH_PREFIX)).toBe(true);
    expect(await heldVouches(ACCOUNT, state.list, [vouch])).toEqual([{ key: tablet.member.key, device: tabletNow.signIn.key }]);
    // Of another list, of another account, a changed signature, one out of form: none holds.
    const other = await migrated(tablet, plan([phone]));
    const cut = { ...vouch, signature: vouch.signature.slice(1) };
    const changed = { ...vouch, signature: `${vouch.signature.startsWith("A") ? "B" : "A"}${vouch.signature.slice(1)}` };
    expect(await heldVouches(ACCOUNT, other.list, [vouch])).toEqual([]);
    expect(await heldVouches("TEST-ONLY-other", state.list, [vouch])).toEqual([]);
    expect(await heldVouches(ACCOUNT, state.list, [cut, changed, { ...vouch, key: "no-key" }, { ...vouch, device: offCurve }])).toEqual([]);
    // The link the other way round is no witness: a member key that names a sign-in key says nothing about that sign-in.
    const stolen = await signVouch(state, { signIn: tablet.member, member: tablet.member });
    const forged = await signVouch(state, { signIn: { key: laptop.signIn.key, privateKey: tablet.member.privateKey }, member: tablet.member });
    expect([stolen, await heldVouches(ACCOUNT, state.list, forged === null ? [] : [forged])]).toEqual([null, []]);
    // A device vouches only for its own member key while that key is in, on the list it follows.
    expect([await signVouch(state, laptop), await signVouch({ ...state, needs_replay: { seq: 2, hash: "00".repeat(32) } }, tabletNow)]).toEqual([null, null]);
  });

  test("it follows when a sign-in key it has let in for a day vouches for the member key the unknown key handed its place to", async () => {
    const { state, tabletNow, vouch, later } = await monthOn();
    const vouched = await heldVouches(ACCOUNT, state.list, [vouch]);
    // The PC's rows are today's sign-ins: it never held the tablet's sign-in key of a month ago.
    expect(migrationVerdict(state, witness([phone, laptop, tabletNow]), later)).toEqual({ pin: false, why: "carried_unknown", keys: [tablet.signIn.key], waits: false, until: null });
    expect(migrationVerdict(state, witness([phone, laptop, tabletNow], { vouched }), later)).toEqual({ pin: true, admitted: [phone.signIn.key, tablet.signIn.key, laptop.signIn.key].sort() });
    // No weaker than its own rows: the vouching key must be one it has let in for a day, and none it holds a removal against.
    const since = later - 3600;
    expect(migrationVerdict(state, witness([phone, laptop, [tabletNow, since]], { vouched }), later)).toEqual({ pin: false, why: "carried_new", keys: [tablet.signIn.key], waits: true, until: since + DAY });
    expect(refusal(migrationVerdict(state, witness([phone, laptop], { vouched }), later))).toBe("carried_unknown");
    expect(refusal(migrationVerdict(state, witness([phone, laptop, tabletNow], { vouched, removed: [tabletNow.signIn.key] }), later))).toBe("carried_unknown");
    // A removal of the member key itself, which a pairing at the PC may hold, wins over everything.
    expect(refusal(migrationVerdict(state, witness([phone, laptop, tabletNow], { vouched, removed: [tablet.member.key] }), later))).toBe("carried_removed");
    // A vouch for some other key does nothing for this one.
    expect(refusal(migrationVerdict(state, witness([phone, laptop, tabletNow], { vouched: [{ key: phone.member.key, device: tabletNow.signIn.key }] }), later))).toBe("carried_unknown");
  });

  test("a stranger's key is not placed by pointing at a device the PC knows: the vouch must be that device's own", async () => {
    const made = await migrated(phone, plan([tablet, stranger]));
    const rotated = await signRotation(made.state, stranger, T0 + 60, null, T0 + 60);
    // The stranger's member key signs that the tablet's sign-in key is its own. Nothing holds, so the PC is handed nothing.
    const claim = await signVouch(rotated.state, { signIn: { key: tablet.signIn.key, privateKey: stranger.member.privateKey }, member: stranger.member });
    const vouched = await heldVouches(ACCOUNT, rotated.state.list, claim === null ? [] : [claim]);
    expect([vouched, refusal(migrationVerdict(rotated.state, witness([phone, tablet], { vouched }), T0 + DAY))]).toEqual([[], "carried_unknown"]);
  });

  test("the device that started the list is gone (the phone was replaced): the PC follows once a device it knows vouches for the list", async () => {
    const { state, tabletNow, vouch, later } = await monthOn();
    const gone = await signListEntry(state, { kind: "remove", ends: phone.member.key }, tablet.member, T0 + 2 * DAY);
    const vouched = await heldVouches(ACCOUNT, state.list, [vouch]);
    expect(refusal(migrationVerdict(gone.state, witness([laptop, tabletNow], { vouched }), later))).toBe("pin");
    // Without the vouch the tablet itself is a device the PC cannot place.
    expect(migrationVerdict(gone.state, witness([laptop, tabletNow]), later)).toEqual({ pin: false, why: "carried_unknown", keys: [tablet.signIn.key], waits: false, until: null });
    // A PC that holds every carried key by its own record, and only lacks the phone's, waits for one device to vouch, and says nothing.
    expect(migrationVerdict(gone.state, witness([laptop, tablet]), later)).toEqual({ pin: false, why: "unvouched", keys: [phone.signIn.key], waits: true, until: null });
    expect(migrationVerdict(gone.state, witness([laptop, tablet, [tabletNow, later - 60]], { vouched }), later)).toEqual({ pin: false, why: "unvouched", keys: [phone.signIn.key], waits: true, until: later - 60 + DAY });
    expect(refusal(migrationVerdict(gone.state, witness([laptop, tablet, tabletNow], { vouched }), later))).toBe("pin");
    const young = later - 60;
    expect(migrationVerdict(gone.state, witness([laptop, [tabletNow, young]], { vouched }), later)).toMatchObject({ why: "carried_new", until: young + DAY });
  });

  test("a list the service made itself and then left: it carries the person's real keys, its own key is gone, and no PC follows", async () => {
    // Every key that is in is one the PC has let in for a month; the key that started the list is out and left nothing.
    const forged = await migrated(stranger, plan([phone, tablet]));
    const left = await signListEntry(forged.state, { kind: "remove", ends: stranger.member.key }, stranger.member, T0 + 60);
    expect(migrationVerdict(left.state, witness([phone, tablet]), T0 + 30 * DAY)).toEqual({ pin: false, why: "unvouched", keys: [stranger.signIn.key], waits: true, until: null });
    // No honest device vouches for a list it does not follow. The stranger's own word is for a key that is out, by a key the PC never let in.
    const own = await signVouch(forged.state, stranger);
    const ownWord = await heldVouches(ACCOUNT, forged.state.list, own === null ? [] : [own]);
    expect([ownWord.length, refusal(migrationVerdict(left.state, witness([phone, tablet], { vouched: ownWord }), T0 + 30 * DAY)), await signVouch(left.state, stranger)]).toEqual([1, "unvouched", null]);
    const young = T0 + 30 * DAY - 60;
    const other = await device("Other");
    const allowed = await signListEntry(forged.state, {
      kind: "device", key: other.member.key, power: "full", role: "drive", until: null, enc: other.enc, sealed: null, rotates: false,
      card: await signCard({ key: other.member.key, enc: other.enc, list: forged.state.list, endpoint: null, invite: null }, other.member.privateKey),
    }, stranger.member, T0 + 30);
    const out = await signListEntry(allowed.state, { kind: "remove", ends: stranger.member.key }, stranger.member, T0 + 60);
    const word = await signVouch(out.state, other);
    const vouched = await heldVouches(ACCOUNT, out.state.list, word === null ? [] : [word]);
    expect(migrationVerdict(out.state, witness([phone, tablet], { vouched }), T0 + 30 * DAY)).toEqual({ pin: false, why: "gone_left_signer", keys: [other.member.key], waits: false, until: null });
    expect(migrationVerdict(out.state, witness([phone, tablet, [other, young]], { vouched }), T0 + 30 * DAY)).toEqual({ pin: false, why: "gone_left_new", keys: [other.member.key], waits: true, until: young + DAY });
    // While its own key is in, it is a key the PC never let in.
    expect(refusal(migrationVerdict(forged.state, witness([phone, tablet]), T0 + 30 * DAY))).toBe("first_signer_unknown");
  });

  test("a device that is gone, and that the PC cannot place, must have left nobody in whom the PC cannot place itself", async () => {
    const { made, later } = await monthOn();
    // The laptop took the new app, handed its place on, allowed a new phone and added a PC at its window; then it was removed.
    const rotated = await signRotation(made.state, laptop, T0 + DAY, null, T0 + DAY);
    const added = await device("New phone");
    const allowed = await signListEntry(rotated.state, {
      kind: "device", key: added.member.key, power: "full", role: "drive", until: null, enc: added.enc, sealed: null, rotates: false,
      card: await signCard({ key: added.member.key, enc: added.enc, list: made.list, endpoint: null, invite: null }, added.member.privateKey),
    }, laptop.member, T0 + 2 * DAY);
    const removed = await signListEntry(allowed.state, { kind: "remove", ends: laptop.member.key }, phone.member, T0 + 3 * DAY);
    const word = await signVouch(removed.state, added);
    const vouched = await heldVouches(ACCOUNT, made.list, word === null ? [] : [word]);
    // The new phone is in: the PC lets its sign-in key in, and that key says which member key is its own.
    expect(migrationVerdict(removed.state, witness([phone, tablet, added]), later)).toEqual({ pin: false, why: "gone_left_signer", keys: [added.member.key], waits: false, until: null });
    expect(refusal(migrationVerdict(removed.state, witness([phone, tablet, added], { vouched }), later))).toBe("pin");
    // Removed too, it is nobody's business any more.
    const both = await signListEntry(removed.state, { kind: "remove", ends: added.member.key }, phone.member, T0 + 4 * DAY);
    expect(refusal(migrationVerdict(both.state, witness([phone, tablet]), later))).toBe("pin");
    // A PC that holds its own record of the laptop asks none of this.
    expect(refusal(migrationVerdict(removed.state, witness([phone, tablet], { once: [laptop.signIn.key] }), later))).toBe("pin");

    // The one case a person settles at the PC: what it left in is a PC, which signs for others and which no row of this PC can place.
    const desk = await device("Desk");
    const pc = await signListEntry(rotated.state, {
      kind: "pc", key: desk.member.key, endpoint: E(9), enc: desk.enc, sealed: null,
      card: await signCard({ key: desk.member.key, enc: desk.enc, list: made.list, endpoint: E(9), invite: null }, desk.member.privateKey),
    }, laptop.member, T0 + 2 * DAY);
    const gone = await signListEntry(pc.state, { kind: "remove", ends: laptop.member.key }, phone.member, T0 + 3 * DAY);
    expect(migrationVerdict(gone.state, witness([phone, tablet]), later)).toEqual({ pin: false, why: "gone_left_signer", keys: [desk.member.key], waits: false, until: null });
    const pcOut = await signListEntry(gone.state, { kind: "remove", ends: desk.member.key }, phone.member, T0 + 4 * DAY);
    expect(refusal(migrationVerdict(pcOut.state, witness([phone, tablet]), later))).toBe("pin");
    // And what that PC let in before it went is asked the same.
    const viaPc = await signListEntry(pc.state, {
      kind: "device", key: added.member.key, power: "full", role: "drive", until: null, enc: added.enc, sealed: null, rotates: false,
      card: await signCard({ key: added.member.key, enc: added.enc, list: made.list, endpoint: null, invite: null }, added.member.privateKey),
    }, desk.member, T0 + 2 * DAY + 60);
    const allOut = await signListEntries(viaPc.state, [{ kind: "remove", ends: laptop.member.key }, { kind: "remove", ends: desk.member.key }], phone.member, T0 + 3 * DAY);
    expect(migrationVerdict(allOut.state, witness([phone, tablet]), later)).toMatchObject({ why: "gone_left_signer", keys: [added.member.key] });
  });
});

describe("what a mutation pass found unpinned", () => {
  const code = async (run: () => Promise<unknown>) => await run().then(() => null, (error: unknown) => (error instanceof MigrationError ? error.code : String(error)));

  test("a time that is no time is no record: negative, not a number, not whole", () => {
    const odd = [-1, Number.NaN, 1.5, "1767225600" as unknown as number];
    for (const since of odd) {
      const start = migrationPlan(known([listed(phone), listed(tablet)], [pcSays(1, [phone, [tablet, since]])]), T0);
      expect(started(start).left.devices).toEqual([{ key: tablet.signIn.key, why: "unwitnessed" }]);
      expect(ownEvidence({ paired: false, since }, T0)).toBe(false);
    }
  });

  test("the first device goes by the PC that has let a key in longest, and a PC named twice is carried in once", () => {
    const young = T0 - 60;
    const start = migrationPlan(known([listed(phone), listed(tablet)], [pcSays(1, [phone, [tablet, young]]), pcSays(2, [phone, tablet]), pcSays(2, [phone, tablet])]), T0);
    expect([started(start).devices.map((row) => row.key), started(start).pcs.map((row) => row.endpoint)]).toEqual([[tablet.signIn.key], [E(1), E(2)]]);
  });

  test("a PC that names a key twice counts it from the later time, and a day means a whole day", async () => {
    const made = await migrated(phone, plan([tablet]));
    const twice: PcWitness = { ...witness([phone]), admits: [...witness([phone]).admits, { key: tablet.signIn.key, since: LONG_AGO }, { key: tablet.signIn.key, since: T0 - 60 }] };
    expect(migrationVerdict(made.state, twice, T0)).toMatchObject({ why: "carried_new", until: T0 - 60 + DAY });
    expect([refusal(migrationVerdict(made.state, witness([phone, [tablet, T0 - DAY]]), T0)), refusal(migrationVerdict(made.state, witness([phone, [tablet, T0 - DAY + 1]]), T0))]).toEqual(["pin", "carried_new"]);
    // Two keys that are both too new: the PC looks again when the later of them has been in for a day.
    const three = await migrated(phone, plan([tablet, laptop]));
    expect(migrationVerdict(three.state, witness([phone, [tablet, T0 - 60], [laptop, T0 - 30]]), T0)).toMatchObject({ why: "carried_new", until: T0 - 30 + DAY, keys: [tablet.signIn.key, laptop.signIn.key].sort() });
  });

  test("a device's own keys are keys of a list, each of them, or nothing is signed", async () => {
    const made = await migrated(phone, plan([tablet]));
    const genesis = await signMigrationGenesis(ACCOUNT, phone, T0, sealer().seals);
    const bad: ListSigner = { key: offCurve, privateKey: tablet.member.privateKey };
    for (const broken of [{ ...tablet, member: bad }, { ...tablet, enc: offCurve }, { ...tablet, signIn: bad }]) {
      expect(await code(() => signRotation(made.state, broken, T0 + 60, null, T0 + 60))).toBe("key_invalid");
    }
    for (const broken of [{ ...phone, member: bad }, { ...phone, enc: offCurve }]) expect(await code(() => signMigrationRun(genesis.state, plan([]), broken, T0, sealer().seals))).toBe("key_invalid");
    // A member key the list has held before is not handed a place.
    expect(await code(() => signRotation(made.state, { ...tablet, member: phone.member }, T0 + 60, null, T0 + 60))).toBe("has_member");
  });

  test("taking the run up again leaves out a PC the list already carries", async () => {
    const sealed = sealer();
    const genesis = await signMigrationGenesis(ACCOUNT, phone, T0, sealed.seals);
    const whole = plan([tablet], [1, 2]);
    const first = await signMigrationRun(genesis.state, whole, phone, T0, sealed.seals);
    const shown = [genesis.text, ...first.entries.slice(0, 2).map((entry) => entry.text)];
    const rest = await signMigrationRun(await replay(shown), whole, phone, T0 + 60, sealed.seals);
    const state = await replay([...shown, ...rest.entries.map((entry) => entry.text)]);
    expect([rest.entries.length, holdsPc(state, E(1)), holdsPc(state, E(2)), state.carrying]).toEqual([3, true, true, false]);
  });

  test("a vouch names an account, a list and two keys, each in its form", async () => {
    const made = await migrated(phone, plan([tablet]));
    const good = { account: ACCOUNT, list: made.list, key: phone.member.key, device: tablet.signIn.key };
    expect(vouchBytes(good).length).toBeGreaterThan(300);
    const odd: Partial<Record<keyof typeof good, unknown>>[] = [
      { account: "" }, { account: 5 }, { account: "a b" }, { list: "00" }, { list: 7 }, { key: offCurve }, { key: 1 }, { device: offCurve }, { device: null }, { device: "x" },
    ];
    for (const change of odd) expect(() => vouchBytes({ ...good, ...change } as typeof good)).toThrow();
    // What is handed over as vouches is read without a throw, whatever it is; a key that vouches for itself is dropped.
    const own = await signVouch(made.state, { signIn: tablet.signIn, member: phone.member });
    if (own === null) throw new Error("no vouch");
    const self = toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, tablet.signIn.privateKey, new Uint8Array(vouchBytes({ ...good, key: tablet.signIn.key })))));
    const junk = [null, "vouch", 5, { ...own, signature: 5 }, { ...own, signature: undefined }, { ...own, key: 5 }, { ...own, device: {} }, { key: tablet.signIn.key, device: tablet.signIn.key, signature: self }] as unknown as SignedVouch[];
    expect(await heldVouches(ACCOUNT, made.list, [...junk, own])).toEqual([{ key: phone.member.key, device: tablet.signIn.key }]);
  });

  test("no rows move from nothing, nor for a member that is stopped; a device a member let in is a member", async () => {
    const made = await migrated(phone, plan([tablet]));
    expect([rekeys(null, made.state), rekeys({ ...made.state, needs_replay: { seq: 1, hash: "00".repeat(32) } }, made.state)]).toEqual([[], []]);
    const added = await device("Added");
    const allowed = await signListEntry(made.state, {
      kind: "device", key: added.member.key, power: "full", role: "drive", until: null, enc: added.enc, sealed: null, rotates: false,
      card: await signCard({ key: added.member.key, enc: added.enc, list: made.list, endpoint: null, invite: null }, added.member.privateKey),
    }, phone.member, T0 + 60);
    expect(devicePlace(allowed.state, { signIn: added.signIn.key, member: added.member.key }, T0 + 60)).toEqual({ at: "member" });
  });

  test("a removal of the key a device handed its place to wins over the PC's own record of the key it came from, and its record of that key needs no vouch", async () => {
    const made = await migrated(phone, plan([tablet]));
    const rotated = await signRotation(made.state, tablet, T0 + 60, null, T0 + 60);
    expect(refusal(migrationVerdict(rotated.state, witness([phone, tablet], { removed: [tablet.member.key] }), T0 + DAY))).toBe("carried_removed");
    // A PC that holds the member key itself (the device was also paired there) and never held the sign-in key.
    const paired: PcWitness = { ...witness([phone]), admits: [...witness([phone]).admits, { key: tablet.member.key, since: LONG_AGO }] };
    expect(refusal(migrationVerdict(rotated.state, paired, T0 + DAY))).toBe("pin");
  });

  test("of two sign-in keys that vouch, the PC waits for the first to be a day old; of two members, for the first of them", async () => {
    const made = await migrated(phone, plan([tablet, laptop]));
    const one = await signRotation(made.state, tablet, T0 + 60, null, T0 + 60);
    const two = await signRotation(one.state, laptop, T0 + 90, null, T0 + 90);
    const gone = await signListEntry(two.state, { kind: "remove", ends: phone.member.key }, tablet.member, T0 + 120);
    const [tabletA, tabletB, laptopNow] = [await signedInAgain(tablet), await signedInAgain(tablet), await signedInAgain(laptop)];
    const words = await Promise.all([tabletA, tabletB, laptopNow].map((who) => signVouch(gone.state, who)));
    const vouched = await heldVouches(ACCOUNT, made.list, words.flatMap((word) => (word === null ? [] : [word])));
    const later = T0 + 30 * DAY;
    // The PC holds the tablet's and the laptop's old sign-in keys by its own record; only the phone, which is gone, needs somebody's word.
    const rows = (a: number, b: number, c: number) => witness([tablet, laptop, [tabletA, a], [tabletB, b], [laptopNow, c]], { vouched });
    expect(migrationVerdict(gone.state, rows(later - 10, later - 20, later - 30), later)).toMatchObject({ why: "unvouched", until: later - 30 + DAY });
    expect(migrationVerdict(gone.state, rows(later - 10, later - 20, later + 5), later)).toMatchObject({ why: "unvouched", until: later - 20 + DAY });
    expect(refusal(migrationVerdict(gone.state, rows(later - 10, later - DAY, later - 30), later))).toBe("pin");
    // The same for a key the PC cannot place but by a vouch: the earlier of its vouchers decides.
    const noRecord = (a: number, b: number) => witness([laptop, [tabletA, a], [tabletB, b], laptopNow], { vouched });
    expect(migrationVerdict(gone.state, noRecord(later - 10, later - 20), later)).toMatchObject({ why: "carried_new", keys: [tablet.signIn.key], until: later - 20 + DAY });
  });

  test("two devices that a gone device let in, each vouched by a key that is too new: the PC looks again when the later is a day old", async () => {
    const made = await migrated(phone, plan([tablet, laptop]));
    let state = (await signRotation(made.state, laptop, T0 + 60, null, T0 + 60)).state;
    const [one, two] = [await device("One"), await device("Two")];
    for (const added of [one, two]) {
      state = (await signListEntry(state, {
        kind: "device", key: added.member.key, power: "full", role: "drive", until: null, enc: added.enc, sealed: null, rotates: false,
        card: await signCard({ key: added.member.key, enc: added.enc, list: made.list, endpoint: null, invite: null }, added.member.privateKey),
      }, laptop.member, T0 + 90)).state;
    }
    state = (await signListEntry(state, { kind: "remove", ends: laptop.member.key }, phone.member, T0 + 120)).state;
    const words = await Promise.all([one, two].map((who) => signVouch(state, who)));
    const vouched = await heldVouches(ACCOUNT, made.list, words.flatMap((word) => (word === null ? [] : [word])));
    const later = T0 + 30 * DAY;
    expect(migrationVerdict(state, witness([phone, tablet, [one, later - 50], [two, later - 20]], { vouched }), later))
      .toEqual({ pin: false, why: "gone_left_new", keys: [one.member.key, two.member.key].sort(), waits: true, until: later - 20 + DAY });
  });

  test("an invite that a device placed before it went lets no PC in, and does not hold a PC back", async () => {
    const made = await migrated(phone, plan([tablet, laptop]));
    const rotated = await signRotation(made.state, laptop, T0 + 60, null, T0 + 60);
    const line = await signer();
    const invite = await signListEntry(rotated.state, { kind: "invite", key: line.key, exp: T0 + 900, uses: 1, auto: true, sealed: null }, laptop.member, T0 + 90);
    const gone = await signListEntry(invite.state, { kind: "remove", ends: laptop.member.key }, phone.member, T0 + 120);
    expect([listView(gone.state).invites.map((row) => row.refusal), refusal(migrationVerdict(gone.state, witness([phone, tablet]), T0 + DAY))]).toEqual([["invite_void"], "pin"]);
  });
});

describe("the vectors of migrate/", () => {
  const DIR = joinPath(import.meta.dir, "account-list-vectors", "migrate");
  interface Vector {
    readonly name: string;
    readonly keys: Readonly<Record<string, { readonly pkcs8: string; readonly spki: string }>>;
    readonly now: number;
    readonly pc?: { readonly entries: readonly string[]; readonly witness: Omit<PcWitness, "vouched">; readonly vouches: readonly SignedVouch[]; readonly expect: MigrationVerdict };
    readonly device?: { readonly known: MigrationKnown; readonly expect: MigrationStart };
  }
  const vectors = readdirSync(DIR).filter((file) => file.endsWith(".json")).sort().map((file) => JSON.parse(readFileSync(joinPath(DIR, file), "utf8")) as Vector);

  test("there is a vector for a PC that follows, for each of its refusals, for a start and for each reason to start none", () => {
    const pcs = new Set(vectors.flatMap((vector) => (vector.pc === undefined ? [] : [refusal(vector.pc.expect)])));
    const refusals: (MigrationRefusal | "pin")[] = [
      "pin", "other_account", "carried_off_curve", "first_signer_removed", "carried_removed", "first_signer_dropped", "carried_dropped", "first_signer_unknown", "carried_unknown", "gone_left_signer",
      "first_signer_new", "carried_new", "gone_left_new", "unvouched", "run_open",
    ];
    expect(refusals.filter((word) => !pcs.has(word))).toEqual([]);
    const starts = new Set(vectors.flatMap((vector) => (vector.device === undefined ? [] : [vector.device.expect.start ? "start" : vector.device.expect.why])));
    expect(["start", "self_unlisted", "self_removed", "no_witness", "self_unwitnessed", "too_new"].filter((word) => !starts.has(word))).toEqual([]);
    for (const vector of vectors) expect(Object.keys(vector.keys).every((name) => name.startsWith("TEST-ONLY-"))).toBe(true);
  });

  for (const vector of vectors) {
    test(`migrate/${vector.name}`, async () => {
      if (vector.pc !== undefined) {
        const replayed = await replayList(vector.pc.entries, LIST_LEVEL, { saved: null });
        expect(replayed.stopped).toBeNull();
        if (replayed.member === null) throw new Error("the vector's list does not replay");
        const vouched = await heldVouches(vector.pc.witness.account, replayed.member.state.list, vector.pc.vouches);
        expect(migrationVerdict(replayed.member.state, { ...vector.pc.witness, vouched }, vector.now)).toEqual(vector.pc.expect);
      }
      if (vector.device !== undefined) expect(migrationPlan(vector.device.known, vector.now)).toEqual(vector.device.expect);
    });
  }
});
