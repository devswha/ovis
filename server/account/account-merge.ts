/**
 * Merging this PC's account state with a sibling state folder at start (T48), before anything is served, with
 * OVIS_ACCOUNT_OPENS_ALL on. Each file by its own rule, and none by time:
 * - `account-pc.json` (P12): the clears are united by `bind_id`; a binding stands only when no clear in that union
 *   names it, and a missing file or a null binding with no clear does not win. Two standing bindings to different
 *   accounts fail closed. `others_ever` holds when either folder says so; `next_admit` stays each folder's own.
 * - `account-removed.json` (P13): markers by (key, account) with the union of their removals by id (one id in both is
 *   one record, whose `over` is the union of its copies); Revokes and their unrevokes as a union by id.
 * - the enrollment barrier stands when either folder has one, and the held keys are a union (S13, T48).
 * A file that cannot be read in either folder is reported, and the PC fails closed (S19).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateState } from "../private-state.ts";
import { ADMISSION_FILE } from "./admission-order.ts";
import { REMOVAL_FILE, type Marker, type Removal, type Revoke, type Unrevoke } from "./removal-evidence.ts";

const ENROLLING_FILE = "account-enrolling.json";
const HELD_FILE = "account-held.json";

type Read = { value: Record<string, unknown> } | "missing";

function read(dir: string, file: string): Read {
  const path = join(dir, file);
  if (!existsSync(path)) return "missing";
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} is not an object`);
  return { value: value as Record<string, unknown> };
}

const byId = <T extends { id: string }>(lists: readonly (readonly T[])[]): T[] => [...new Map(lists.flat().map((item) => [item.id, item])).values()];

function mergePc(active: string, sibling: string): void {
  const [own, other] = [read(active, ADMISSION_FILE), read(sibling, ADMISSION_FILE)];
  if (other === "missing") return;
  if (own === "missing") { writePrivateState(join(active, ADMISSION_FILE), other.value); return; }
  type Clear = { bind_id: string };
  type Binding = { account: string; bind_id: string } | null;
  const clears = [...new Map([...own.value.clears as Clear[], ...other.value.clears as Clear[]].map((clear) => [clear.bind_id, clear])).values()];
  const standing = [own.value.binding as Binding, other.value.binding as Binding].filter((binding): binding is NonNullable<Binding> => binding !== null && !clears.some((clear) => clear.bind_id === binding.bind_id));
  if (new Set(standing.map((binding) => binding.account)).size > 1) throw new Error(`${active} and ${sibling} are bound to two different accounts`);
  const binding = standing[0] ?? null;
  const othersEver = own.value.others_ever === true || other.value.others_ever === true || JSON.stringify(own.value.first) !== JSON.stringify(other.value.first);
  for (const [dir, doc] of [[active, own.value], [sibling, other.value]] as const) {
    writePrivateState(join(dir, ADMISSION_FILE), { ...doc, binding, clears, others_ever: othersEver, gen: Math.max(Number(own.value.gen ?? 0), Number(other.value.gen ?? 0)) });
  }
}

function mergeEvidence(active: string, sibling: string): void {
  const docs = [read(active, REMOVAL_FILE), read(sibling, REMOVAL_FILE)].flatMap((doc) => doc === "missing" ? [] : [doc.value]);
  if (docs.length < 2) {
    if (docs.length === 1) for (const dir of [active, sibling]) if (!existsSync(join(dir, REMOVAL_FILE))) writePrivateState(join(dir, REMOVAL_FILE), docs[0]);
    return;
  }
  const markers = new Map<string, Marker>();
  for (const marker of docs.flatMap((doc) => doc.markers as Marker[])) {
    const at = JSON.stringify([marker.key, marker.account]);
    const kept = markers.get(at);
    if (kept === undefined) { markers.set(at, marker); continue; }
    const removals = new Map<string, Removal>(kept.removals.map((removal) => [removal.id, removal]));
    for (const removal of marker.removals) {
      const same = removals.get(removal.id);
      removals.set(removal.id, same === undefined ? removal : { ...same, over: [...new Set([...same.over, ...removal.over])] });
    }
    markers.set(at, { ...kept, removals: [...removals.values()] });
  }
  const merged = { v: 1, markers: [...markers.values()], revokes: byId(docs.map((doc) => doc.revokes as Revoke[])), unrevokes: byId(docs.map((doc) => doc.unrevokes as Unrevoke[])) };
  for (const dir of [active, sibling]) writePrivateState(join(dir, REMOVAL_FILE), merged);
}

function mergeHolds(active: string, sibling: string): void {
  const [ownBarrier, otherBarrier] = [read(active, ENROLLING_FILE), read(sibling, ENROLLING_FILE)];
  if (ownBarrier === "missing" && otherBarrier !== "missing") writePrivateState(join(active, ENROLLING_FILE), otherBarrier.value);
  if (otherBarrier === "missing" && ownBarrier !== "missing") writePrivateState(join(sibling, ENROLLING_FILE), ownBarrier.value);
  const held = [read(active, HELD_FILE), read(sibling, HELD_FILE)].flatMap((doc) => doc === "missing" ? [] : [doc.value]);
  if (held.length === 0) return;
  const merged = { keys: [...new Set(held.flatMap((doc) => doc.keys as string[]))], full: held.some((doc) => doc.full === true) };
  for (const dir of [active, sibling]) writePrivateState(join(dir, HELD_FILE), merged);
}

/** Merges the account state of `sibling` into `active` and back; why it could not, or null. */
export function mergeAccountState(active: string, sibling: string): string | null {
  try {
    mergePc(active, sibling);
    mergeEvidence(active, sibling);
    mergeHolds(active, sibling);
    return null;
  } catch (error) {
    return `Cannot merge the account state of ${sibling} into ${active} (${error instanceof Error ? error.message : String(error)}): only this PC itself gets in until it is restored.`;
  }
}
