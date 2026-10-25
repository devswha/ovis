/**
 * An install from before 0.4.16 could keep its state in two dirs: a fresh 0.4.14 or 0.4.15 install
 * kept it under the new name (ovis) until its next restart, its first update included, which took
 * the old one (herdr-web-ui) because the bridge registry is created there (update-state.ts). Each
 * dir may then hold paired devices, shared preferences and push subscriptions the other lacks. A
 * server whose state dir is one of the two takes over the other's before any store reads them.
 *
 * Paired devices (devices.json) are an authorization record, so both dirs end with the same one:
 * a release before this one that ever reads either finds every device and a closed gate. Devices are
 * merged by id against the ids both held after the last merge (state-merge.json, kept in both dirs):
 * one only one side holds is new there and is kept, unless the last merge had it, which means it was
 * revoked on the other side since, and it stays revoked. The first merge has nothing to compare with
 * and keeps every device. The gate is closed from the earliest evidence either side holds, so a merge
 * never opens it. A registry or merge record that cannot be read fails closed: the store stays gated
 * and pairs nothing (devices.ts), and neither registry is written.
 *
 * Preferences and mutes, too, end alike in both dirs. A setting (or the pins) the other dir changed
 * since the last merge is laid over this dir's unless this dir changed it too; then the preferences
 * document written last wins. The first merge counts every setting as changed on both sides. Mutes
 * follow the other dir's additions and removals since the last merge. Push subscriptions go to the
 * dir in use only, each taken over once, with the key pair it was made for (push.ts PUSH_EXTRA_KEYS).
 *
 * Nothing is deleted: a file about to be replaced is first copied to `state-merge-backups/<time>/`
 * in its own dir. Every write replaces a whole file atomically and the merge only adds what one side
 * holds or removes what one side dropped since the last merge, so a merge stopped at any point
 * (a crash, a power loss) merges the same way at the next start.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_PREFERENCES_BYTES, sharedPreferencesBody, type PreferencesChange } from "../shared/preferences.ts";
import { readDeviceRegistry, type StoredDevice } from "./devices.ts";
import { writePrivateState } from "./private-state.ts";
import { PUSH_EXTRA_KEYS } from "./push.ts";
import { readStateDocument, writeStateDocument } from "./state-document.ts";
import { stateDirNames } from "./update-state.ts";

const RECORD = "state-merge.json";
const BACKUPS = "state-merge-backups";

/** What a merge leaves the device store to know. */
export interface SiblingMerge {
  /** why the device registries could not be merged: the store must stay gated (devices.ts) */
  devicesBlocked: string | null;
}

/**
 * The other of the two default state dirs, when `active` is one of them and the other is a dir of
 * its own (not a link to `active`): that one may hold state `active` lacks. A custom
 * OVIS_STATE_DIR elsewhere has none.
 */
export function siblingStateDir(active: string, env: Record<string, string | undefined> = process.env): string | null {
  const { legacy, next } = stateDirNames(env);
  const own = resolve(active);
  const other = own === resolve(legacy) ? next : own === resolve(next) ? legacy : null;
  if (other === null) return null;
  try {
    if (!statSync(other).isDirectory()) return null;
  } catch (error) {
    // an other dir that cannot be looked at may hold devices: the merge then fails closed
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : other;
  }
  return realpath(other) === realpath(own) ? null : other;
}

function realpath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

interface Registry { gate_closed_at: string | null; devices: StoredDevice[] }
interface PreferencesSnapshot { settings: PreferencesChange["settings"]; pins?: string[]; muted_panes: string[] }
interface MergeRecord {
  version: 1;
  /** one more than the newest record of the two dirs: the clock may go back, this never does */
  seq: number;
  at: string;
  /** both dirs' real paths, sorted */
  dirs: string[];
  /** the device ids both registries held after the last merge that wrote both */
  devices: string[];
  /** each dir's preferences after this merge, by real path */
  preferences: Record<string, PreferencesSnapshot>;
  /** the hashes of the endpoints taken over from each dir, by its real path */
  push: Record<string, string[]>;
}

const text = (value: unknown): string => JSON.stringify(value);
const endpointHash = (endpoint: string): string => createHash("sha256").update(endpoint).digest("base64url");
const earliest = (values: (string | null | undefined)[]): string | null =>
  values.filter((value): value is string => typeof value === "string").sort()[0] ?? null;

/**
 * Merges two registries by device id; `base` holds the ids both had after the last merge (null:
 * none happened). A device one side dropped since then stays dropped; one only one side added is
 * kept. A device both hold keeps this side's credential and label, the narrower role, its first
 * creation and its last sighting. A missing registry (`null`) says nothing was dropped there.
 */
export function mergeRegistries(own: Registry | null, other: Registry | null, base: ReadonlySet<string> | null): Registry {
  const mine = own?.devices ?? [];
  const theirs = other?.devices ?? [];
  const theirIds = new Set(theirs.map((device) => device.id));
  const myIds = new Set(mine.map((device) => device.id));
  const devices: StoredDevice[] = [];
  for (const device of mine) {
    // revoked through the other dir since the last merge
    if (other !== null && base?.has(device.id) && !theirIds.has(device.id)) continue;
    const twin = theirs.find((candidate) => candidate.id === device.id);
    if (!twin || twin.token_hash !== device.token_hash) {
      if (twin) console.error(`Paired device ${device.id} has another credential in the other state dir; the one in use is kept`);
      devices.push(device);
      continue;
    }
    devices.push({
      ...device,
      role: device.role === "watch" || twin.role === "watch" ? "watch" : "drive",
      created_at: earliest([device.created_at, twin.created_at])!,
      last_seen_at: [device.last_seen_at, twin.last_seen_at].filter((seen): seen is string => seen !== null).sort().at(-1) ?? null,
    });
  }
  for (const device of theirs) {
    // revoked here since the last merge
    if (myIds.has(device.id) || own !== null && base?.has(device.id)) continue;
    devices.push(device);
  }
  // every piece of evidence that either side was ever gated keeps the merge gated
  const gate = earliest([own?.gate_closed_at, other?.gate_closed_at, ...mine.map((d) => d.created_at), ...theirs.map((d) => d.created_at)]);
  return { gate_closed_at: gate, devices };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isSnapshot = (value: unknown): value is PreferencesSnapshot =>
  isObject(value) && isObject(value["settings"]) && isStrings(value["muted_panes"]) && (value["pins"] === undefined || isStrings(value["pins"]));
const isRecord = (value: unknown): value is MergeRecord =>
  isObject(value) && value["version"] === 1 && Number.isSafeInteger(value["seq"]) && typeof value["at"] === "string"
  && isStrings(value["dirs"]) && isStrings(value["devices"])
  && isObject(value["preferences"]) && Object.values(value["preferences"]).every(isSnapshot)
  && isObject(value["push"]) && Object.values(value["push"]).every(isStrings);

/** The merge record both dirs share, the newer one when they differ; null when there is none yet. Throws when one cannot be read. */
function readRecord(dirs: string[], pair: string[]): MergeRecord | null {
  let found: MergeRecord | null = null;
  for (const dir of dirs) {
    const read = readStateDocument(join(dir, RECORD));
    if (read.kind === "missing") continue;
    const value = read.kind === "json" ? read.value : null;
    if (!isRecord(value)) throw new Error(`${join(dir, RECORD)} is not a state merge record`);
    // a record of another pair of dirs (one moved since) says nothing about these
    if (text(value.dirs) !== text(pair)) continue;
    if (found === null || value.seq > found.seq) found = value;
  }
  return found;
}

/**
 * A merge that cannot run leaves the store gated in this process only. So that a release before
 * this one, which knows nothing of the merge, stays gated on this dir too, the dir's own registry
 * gets a closed gate, its devices as they are; a damaged one is left alone (it keeps every release gated).
 */
function closeGateOnDisk(active: string, stamp: string, now: Date): void {
  const path = join(active, "devices.json");
  const own = readDeviceRegistry(path);
  if (own.kind === "bad" || own.kind === "ok" && (own.gateClosedAt !== null || own.devices.length > 0)) return;
  try {
    backUp(active, "devices.json", stamp);
    // where there was no registry, the mark keeps the next merge from reading its empty list as every device revoked
    writePrivateState(path, { gate_closed_at: now.toISOString(), devices: own.kind === "ok" ? own.devices : [], ...(own.kind === "missing" ? { placeholder: true } : {}) });
  } catch (error) {
    console.error(`Cannot close the gate in ${path}: a release before this one may start on it ungated: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Copies `name` in `dir`, if it is there, to the backups of this merge before it is replaced. */
function backUp(dir: string, name: string, stamp: string): void {
  const from = join(dir, name);
  try { statSync(from); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const to = join(dir, BACKUPS, stamp);
  mkdirSync(to, { recursive: true, mode: 0o700 });
  copyFileSync(from, join(to, name));
}

/** A preferences document and its mutes, as each store reads them; null when either is damaged. */
function readPreferences(dir: string): { doc: PreferencesSnapshot & { revision: number }; written: number } | null {
  const read = readStateDocument(join(dir, "preferences.json"));
  const mutes = readStateDocument(join(dir, "muted-panes.json"));
  const body = read.kind === "missing" ? { settings: {} } : sharedPreferencesBody(read.kind === "json" ? read.value : undefined);
  const muted = mutes.kind === "missing" ? [] : mutes.kind === "json" ? sharedPreferencesBody({ settings: {}, muted_panes: (mutes.value as { muted_panes?: unknown } | null)?.muted_panes })?.muted_panes : undefined;
  if (body === null || muted === undefined) return null;
  const raw = read.kind === "json" ? read.value as { revision?: unknown } : {};
  const revision = Number.isSafeInteger(raw.revision) ? Math.max(0, raw.revision as number) : 0;
  // settings and pins conflict by this document alone: mutes never do (they merge as a set)
  let written = 0;
  try { written = statSync(join(dir, "preferences.json")).mtimeMs; } catch { /* absent */ }
  return { doc: { revision, settings: body.settings, ...(body.pins === undefined ? {} : { pins: body.pins }), muted_panes: muted ?? [] }, written };
}

function mergeDevices(active: string, sibling: string, base: MergeRecord | null, stamp: string): { blocked: string | null; ids: string[] | null; changed: number } {
  const ownPath = join(active, "devices.json");
  const otherPath = join(sibling, "devices.json");
  const own = readDeviceRegistry(ownPath);
  const other = readDeviceRegistry(otherPath);
  const unreadable = own.kind === "bad" ? ownPath : other.kind === "bad" ? otherPath : null;
  if (unreadable !== null) {
    return { ids: null, changed: 0, blocked: `Cannot read ${unreadable}, so the paired devices of ${active} and ${sibling} cannot be merged. Restore a valid devices.json there or fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.` };
  }
  // a placeholder (closeGateOnDisk) counts as no registry, its closed gate as evidence
  const registry = (read: typeof own): Registry | null => read.kind === "ok" && !read.placeholder ? { gate_closed_at: read.gateClosedAt, devices: read.devices } : null;
  const mine = registry(own);
  const theirs = registry(other);
  const gates = [own, other].map((read) => read.kind === "ok" ? read.gateClosedAt : null);
  if (mine === null && theirs === null && gates.every((gate) => gate === null)) return { blocked: null, ids: [], changed: 0 };
  const merged: Registry & { placeholder?: true } = mergeRegistries(mine, theirs, base ? new Set(base.devices) : null);
  // a closed gate on either side, a placeholder's included, keeps the merge closed
  merged.gate_closed_at = earliest([merged.gate_closed_at, ...gates]);
  // made of placeholders alone, the result is one too: it holds no device list to revoke from
  if (mine === null && theirs === null) merged.placeholder = true;
  const onDisk = (read: typeof own) => read.kind === "ok" ? { gate_closed_at: read.gateClosedAt, devices: read.devices, ...(read.placeholder ? { placeholder: true } : {}) } : null;
  const added = merged.devices.filter((device) => !mine?.devices.some((held) => held.id === device.id)).length;
  if (text(onDisk(own)) !== text(merged)) {
    try {
      backUp(active, "devices.json", stamp);
      writePrivateState(ownPath, merged);
    } catch (error) {
      return { ids: null, changed: 0, blocked: `Cannot write the paired devices of ${sibling} into ${ownPath} (${error instanceof Error ? error.message : String(error)}). Fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.` };
    }
  }
  if (text(onDisk(other)) !== text(merged)) {
    try {
      backUp(sibling, "devices.json", stamp);
      writePrivateState(otherPath, merged);
    } catch (error) {
      // the dir in use is complete; a release before this one reading the other dir would miss what changed here
      console.error(`Cannot write the merged paired devices into ${otherPath}: ${error instanceof Error ? error.message : String(error)}`);
      // the base of the next merge is what the other dir still holds of what both held: the devices
      // both hold now, and those of the last base it still holds although this dir revoked them
      const known = new Set([...merged.devices.map((device) => device.id), ...base?.devices ?? []]);
      return { blocked: null, ids: (theirs?.devices ?? []).map((device) => device.id).filter((id) => known.has(id)), changed: added };
    }
  }
  return { blocked: null, ids: merged.devices.map((device) => device.id), changed: added };
}

function mergePreferences(active: string, sibling: string, base: MergeRecord | null, stamp: string): Record<string, PreferencesSnapshot> | null {
  const own = readPreferences(active);
  const other = readPreferences(sibling);
  if (own === null || other === null) {
    console.error(`The shared preferences of ${own === null ? active : sibling} cannot be read; those of ${sibling} are not merged into ${active}`);
    return null;
  }
  const before = base?.preferences[realpath(sibling)] ?? null;
  const mineBefore = base?.preferences[realpath(active)] ?? null;
  const theirsNewer = other.written > own.written;
  // a value one side holds that differs from its own at the last merge (any value, at the first)
  const changed = (value: unknown, was: PreferencesSnapshot | null, at: (snapshot: PreferencesSnapshot) => unknown) =>
    value !== undefined && (was === null || text(value) !== text(at(was)));
  const take = (mine: unknown, theirs: unknown, at: (snapshot: PreferencesSnapshot) => unknown): boolean =>
    changed(theirs, before, at) && text(mine) !== text(theirs) && (mine === undefined || !changed(mine, mineBefore, at) || theirsNewer);
  const settings: Record<string, unknown> = { ...own.doc.settings };
  for (const [key, value] of Object.entries(other.doc.settings)) {
    const at = (snapshot: PreferencesSnapshot) => (snapshot.settings as Record<string, unknown>)[key];
    if (take(settings[key], value, at)) settings[key] = value;
  }
  const pins = take(own.doc.pins, other.doc.pins, (snapshot) => snapshot.pins) ? other.doc.pins : own.doc.pins;
  const was = new Set(before?.muted_panes ?? []);
  const now = new Set(other.doc.muted_panes);
  const muted = [...own.doc.muted_panes.filter((pane) => !(before !== null && was.has(pane) && !now.has(pane))),
    ...other.doc.muted_panes.filter((pane) => !own.doc.muted_panes.includes(pane) && !was.has(pane))];
  const merged = { settings: settings as PreferencesChange["settings"], ...(pins === undefined ? {} : { pins }), muted_panes: muted };
  const document = { revision: Math.max(own.doc.revision, other.doc.revision) + 1, settings: merged.settings, ...(pins === undefined ? {} : { pins }) };
  // what each store would read back: two lists each within their limit may not be together
  if (sharedPreferencesBody(merged) === null || new TextEncoder().encode(text({ ...document, muted_panes: muted })).length > MAX_PREFERENCES_BYTES) {
    console.error(`The shared preferences of ${sibling} and ${active} together are too large; those of ${sibling} are not merged`);
    return null;
  }
  /** Writes the merged document where it differs; false when that failed. */
  const write = (dir: string, held: PreferencesSnapshot): boolean => {
    try {
      if (text(merged.settings) !== text(held.settings) || text(pins) !== text(held.pins)) {
        backUp(dir, "preferences.json", stamp);
        writeStateDocument(join(dir, "preferences.json"), `${JSON.stringify(document, null, 2)}\n`, false);
      }
      if (text(muted) !== text(held.muted_panes)) {
        backUp(dir, "muted-panes.json", stamp);
        writeStateDocument(join(dir, "muted-panes.json"), `${JSON.stringify({ muted_panes: muted }, null, 2)}\n`, false);
      }
      return true;
    } catch (error) {
      console.error(`Cannot write the merged shared preferences into ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  if (!write(active, own.doc)) return null;
  // both dirs end alike, as the devices do: whichever one a later start uses has every setting.
  // Where the other dir could not be written, the last merge's snapshots stay: what this dir took
  // in is then still a change here, and reaches the other dir at the next merge, whichever is in use
  if (!write(sibling, other.doc)) return null;
  return { [realpath(active)]: merged, [realpath(sibling)]: merged };
}

type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } } & Record<string, unknown>;

/** A JSON file of the push service: undefined when absent. Throws when it cannot be read or parsed. */
function readPushFile(path: string): unknown {
  const read = readStateDocument(path);
  if (read.kind === "malformed") throw new Error(`${path} is not JSON`);
  return read.kind === "json" ? read.value : undefined;
}

function subscriptionsIn(value: unknown): Subscription[] {
  return (Array.isArray(value) ? value : []).filter((entry): entry is Subscription => {
    const { endpoint, keys } = (entry ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    return typeof endpoint === "string" && typeof keys?.p256dh === "string" && typeof keys.auth === "string";
  });
}

type Vapid = { publicKey: string; privateKey: string };

function vapidIn(value: unknown): Vapid | null {
  const { publicKey, privateKey } = (value ?? {}) as { publicKey?: unknown; privateKey?: unknown };
  return typeof publicKey === "string" && typeof privateKey === "string" ? { publicKey, privateKey } : null;
}

function mergePush(active: string, sibling: string, base: MergeRecord | null, stamp: string): { record: Record<string, string[]>; taken: number } | null {
  try {
    const theirs = subscriptionsIn(readPushFile(join(sibling, "push-subscriptions.json")));
    const theirKey = vapidIn(readPushFile(join(sibling, "vapid.json")));
    const before = base?.push[realpath(sibling)] ?? [];
    const record = { [realpath(sibling)]: [...new Set([...before, ...theirs.map((subscription) => endpointHash(subscription.endpoint))])] };
    if (theirs.length === 0) return { record, taken: 0 };
    // the key each of their subscriptions was made for: one they took over keeps its own
    const theirExtra = new Map<string, Vapid>();
    const extraFile = readPushFile(join(sibling, PUSH_EXTRA_KEYS)) as { keys?: unknown } | undefined;
    for (const entry of Array.isArray(extraFile?.keys) ? extraFile.keys as { endpoints?: unknown }[] : []) {
      const key = vapidIn(entry);
      if (key !== null && isStrings(entry.endpoints)) for (const endpoint of entry.endpoints) theirExtra.set(endpoint, key);
    }
    const keyOf = (endpoint: string): Vapid | null => theirExtra.get(endpoint) ?? theirKey;
    const mine = subscriptionsIn(readPushFile(join(active, "push-subscriptions.json")));
    const myFile = readPushFile(join(active, "vapid.json"));
    let myKey = vapidIn(myFile);
    // push.ts never replaces a damaged key file (every subscription made for it would go): neither does this
    if (myFile !== undefined && myKey === null) throw new Error(`${join(active, "vapid.json")} is malformed`);
    let retired: string[] = [];
    try {
      const value = readPushFile(join(active, "push-retired.json"));
      retired = (Array.isArray(value) ? value : []).map((entry) => (entry as { hash?: unknown } | null)?.hash).filter((hash): hash is string => typeof hash === "string");
    } catch { /* telemetry: an endpoint it would have kept out only fails its next push */ }
    const taken = theirs.filter((subscription) => !mine.some((held) => held.endpoint === subscription.endpoint)
      && !before.includes(endpointHash(subscription.endpoint)) && !retired.includes(endpointHash(subscription.endpoint))
      && keyOf(subscription.endpoint) !== null);
    if (taken.length === 0) return { record, taken: 0 };
    if (myKey === null && theirKey !== null) {
      // this dir has signed nothing yet: the other dir's key becomes its own
      writePrivateState(join(active, "vapid.json"), theirKey);
      myKey = theirKey;
    }
    const foreign = taken.filter((subscription) => keyOf(subscription.endpoint)!.publicKey !== myKey?.publicKey);
    if (foreign.length > 0) {
      const path = join(active, PUSH_EXTRA_KEYS);
      const stored = readPushFile(path) as { keys?: unknown } | undefined;
      const keys = (Array.isArray(stored?.keys) ? stored.keys : []) as { publicKey?: unknown; privateKey?: unknown; endpoints?: unknown }[];
      for (const subscription of foreign) {
        const key = keyOf(subscription.endpoint)!;
        const index = keys.findIndex((held) => held.publicKey === key.publicKey);
        const endpoints = index === -1 ? [] : isStrings(keys[index]!.endpoints) ? keys[index]!.endpoints as string[] : [];
        const entry = { ...key, endpoints: [...new Set([...endpoints, subscription.endpoint])] };
        if (index === -1) keys.push(entry);
        else keys[index] = entry;
      }
      backUp(active, PUSH_EXTRA_KEYS, stamp);
      writePrivateState(path, { keys });
    }
    backUp(active, "push-subscriptions.json", stamp);
    writePrivateState(join(active, "push-subscriptions.json"), [...mine, ...taken]);
    return { record, taken: taken.length };
  } catch (error) {
    console.error(`Cannot merge the push subscriptions of ${sibling} into ${active}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Takes over `sibling`'s paired devices, shared preferences and push subscriptions into `active`
 * (see the top of this file). Call it before any store of `active` reads them.
 */
export function mergeSiblingState(active: string, sibling: string, now = new Date()): SiblingMerge {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let blocked: string | null;
  try {
    blocked = merge(active, sibling, now, stamp);
  } catch (error) {
    // whatever went wrong, the server still starts, gated: a start that failed would fall back to an older release
    blocked = `Cannot merge the state of ${sibling} into ${active} (${error instanceof Error ? error.message : String(error)}). External access without a token or trusted Tailscale login remains blocked; restart the server once it is fixed.`;
  }
  // the device store says why (devices.ts)
  if (blocked !== null) closeGateOnDisk(active, stamp, now);
  return { devicesBlocked: blocked };
}

function merge(active: string, sibling: string, now: Date, stamp: string): string | null {
  const pair = [realpath(active), realpath(sibling)].sort();
  let base: MergeRecord | null;
  try {
    base = readRecord([active, sibling], pair);
  } catch (error) {
    // without the last merge a revoked device could come back: nothing is merged, and the store stays gated
    return `${error instanceof Error ? error.message : String(error)}, so the paired devices of ${active} and ${sibling} cannot be merged. Restore or remove it, then restart the server. External access without a token or trusted Tailscale login remains blocked.`;
  }
  const devices = mergeDevices(active, sibling, base, stamp);
  const preferences = mergePreferences(active, sibling, base, stamp);
  const push = mergePush(active, sibling, base, stamp);
  if (devices.changed > 0 || push !== null && push.taken > 0) {
    console.log(`Ovis took over ${devices.changed} paired device(s) and ${push?.taken ?? 0} push subscription(s) from ${sibling} into ${active}; replaced files are kept in ${join(active, BACKUPS)}`);
  }
  const record: MergeRecord = {
    version: 1,
    seq: (base?.seq ?? 0) + 1,
    at: now.toISOString(),
    dirs: pair,
    // a merge that could not run keeps the last one's base, so the next one compares with it
    devices: devices.ids ?? base?.devices ?? [],
    preferences: preferences ?? base?.preferences ?? {},
    push: { ...base?.push, ...push?.record },
  };
  let blocked = devices.blocked;
  for (const dir of [active, sibling]) {
    try { writePrivateState(join(dir, RECORD), record); }
    catch (error) {
      const reason = `Cannot write ${join(dir, RECORD)}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(reason);
      // without it the next merge compares with an older one, and would bring back a device revoked
      // until then: this run changes no device, so it cannot revoke one
      if (dir === active) blocked ??= `${reason}. Fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.`;
    }
  }
  return blocked;
}
