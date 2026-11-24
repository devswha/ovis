import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import {
  LIST_LEVEL, admitsDevice, holdsPc, listView, namesFields, readNames, replayList, sealEpoch, signListEntries, signListEntry,
  type ListNames, type ListSigner, type ListState,
} from "./account-list.ts";
import { epochKeyCommitment, newEpochKey, nextEpoch, openSealed, sealFields, type EpochKey } from "./account-list-seal.ts";
import {
  MIGRATION_CARRIED_MAX, MIGRATION_RUN_SECONDS, MIGRATION_WITNESS_SECONDS, MigrationError, devicePlace, heirOf, migrationPlan, migrationVerdict, ownEvidence, rekeys,
  signMigrationGenesis, signMigrationRun, signRotation, standsFor,
  type KnownDevice, type KnownPc, type MigratingDevice, type MigrationKnown, type MigrationPlan, type MigrationRefusal, type MigrationSeals, type MigrationStart, type MigrationVerdict,
  type PcWitness,
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
function witness(admits: readonly (Device | readonly [Device, number])[], rest: Partial<Pick<PcWitness, "removed" | "once" | "account">> = {}): PcWitness {
  return {
    account: rest.account ?? ACCOUNT,
    admits: admits.map((one) => ("signIn" in one ? { key: one.signIn.key, since: LONG_AGO } : { key: one[0].signIn.key, since: one[1] })),
    removed: rest.removed ?? [], once: rest.once ?? [],
  };
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

  test("the run is one request: devices first, and what is past its room is left out", async () => {
    const many = await Promise.all(Array.from({ length: MIGRATION_CARRIED_MAX - 1 }, (_, index) => device(`Device ${index}`)));
    const start = started(migrationPlan(known([listed(phone), ...many.map((one) => listed(one))], [pcSays(1, [phone, ...many]), pcSays(2, [phone]), pcSays(3, [phone])]), T0));
    expect([start.devices.length, start.pcs.map((row) => row.endpoint), start.left.pcs]).toEqual([MIGRATION_CARRIED_MAX - 1, [E(1)], [{ endpoint: E(2), why: "over_limit" }, { endpoint: E(3), why: "over_limit" }]]);
    const made = await migrated(phone, start);
    // Entry 0 is its own request; the run, the entry that ends it and the epoch are the sixteen of one.
    expect(made.texts.length - 1).toBe(16);
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
    // Also once the stranger is out again: it was a signer of power `full` meanwhile.
    const removed = await signListEntry(made.state, { kind: "remove", ends: stranger.signIn.key }, phone.member, T0 + 60);
    expect(refusal(migrationVerdict(removed.state, witness([phone, tablet]), T0 + 60))).toBe("carried_unknown");
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
    const holds: PcWitness = { account: ACCOUNT, admits: [...witness([phone, tablet]).admits, { key: offCurve, since: LONG_AGO }], removed: [], once: [] };
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
    // A PC that keeps no record of what it dropped does not follow either, and says so: it is added again at the PC.
    expect(refusal(migrationVerdict(removed.state, witness([phone, tablet]), later))).toBe("carried_unknown");
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

describe("the vectors of migrate/", () => {
  const DIR = joinPath(import.meta.dir, "account-list-vectors", "migrate");
  interface Vector {
    readonly name: string;
    readonly keys: Readonly<Record<string, { readonly pkcs8: string; readonly spki: string }>>;
    readonly now: number;
    readonly pc?: { readonly entries: readonly string[]; readonly witness: PcWitness; readonly expect: MigrationVerdict };
    readonly device?: { readonly known: MigrationKnown; readonly expect: MigrationStart };
  }
  const vectors = readdirSync(DIR).filter((file) => file.endsWith(".json")).sort().map((file) => JSON.parse(readFileSync(joinPath(DIR, file), "utf8")) as Vector);

  test("there is a vector for a PC that follows, for each of its refusals, for a start and for each reason to start none", () => {
    const pcs = new Set(vectors.flatMap((vector) => (vector.pc === undefined ? [] : [refusal(vector.pc.expect)])));
    const refusals: (MigrationRefusal | "pin")[] = [
      "pin", "other_account", "carried_off_curve", "first_signer_removed", "carried_removed", "first_signer_dropped", "carried_dropped", "first_signer_unknown", "carried_unknown", "first_signer_new", "carried_new", "run_open",
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
        expect(migrationVerdict(replayed.member.state, vector.pc.witness, vector.now)).toEqual(vector.pc.expect);
      }
      if (vector.device !== undefined) expect(migrationPlan(vector.device.known, vector.now)).toEqual(vector.device.expect);
    });
  }
});
