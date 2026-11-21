/**
 * The screen's menu: one list that reaches every place to go (workspaces, the shown workspace's tabs, the shown tab's
 * panes, the agents) and every built action of the catalogue. Every entry is chosen with the arrows and Enter, or by
 * its key: a digit for the first ten places, a letter for each action. Neither needs Escape, Ctrl or a key an input
 * method composes before it is sent, so a phone keyboard or a Korean input method reaches every action once the menu
 * is open (it opens by a click on the header as well as by its key after the prefix).
 */
import type { HerdrAction } from "../../shared/herdr-keys.ts";
import { CATALOGUE } from "./catalogue.ts";
import type { KeyInput, OverlayChoice } from "./effects.ts";
import { type Focus, focused, type World } from "./focus.ts";

type PlaceKind = "workspace" | "tab" | "pane" | "agent";

/** One line of the menu: a place (its id; an agent's and a pane's is the pane's) or an action; `label` the key that chooses it. */
export type MenuEntry =
  | { readonly kind: PlaceKind; readonly id: string; readonly label: string | null }
  | { readonly kind: "action"; readonly action: HerdrAction; readonly label: string };

/** The keys of the first places, in order: digits, which every keyboard types and no input method composes. */
const PLACE_LABELS = [..."1234567890"];
/** The keys of the actions, in the catalogue's order: as many letters as herdr has actions. */
const ACTION_LABELS = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** The menu's entries for what exists now and where the screen looks. */
export function menuEntries(world: World, focus: Focus): MenuEntry[] {
  const shown = focused(world, focus);
  const places: { kind: PlaceKind; id: string }[] = [
    ...world.workspaces.map(({ id }) => ({ kind: "workspace" as const, id })),
    ...(shown.workspace?.tabs ?? []).map(({ id }) => ({ kind: "tab" as const, id })),
    // one terminal shows at a time on a narrow screen: the others of its tab are reached here
    ...((shown.tab?.panes.length ?? 0) > 1 ? shown.tab!.panes.map(({ id }) => ({ kind: "pane" as const, id })) : []),
    ...(world.agents ?? []).map((id) => ({ kind: "agent" as const, id })),
  ];
  const actions = CATALOGUE.filter((entry) => entry.status === "built");
  return [
    ...places.map((place, at): MenuEntry => ({ ...place, label: PLACE_LABELS[at] ?? null })),
    ...actions.map(({ id }, at): MenuEntry => ({ kind: "action", action: id, label: ACTION_LABELS[at]! })),
  ];
}

const entryKey = (entry: MenuEntry): string => entry.kind === "action" ? `action:${entry.action}` : `${entry.kind}:${entry.id}`;

/** The cursor's place among `next` for the entry it was on in `before`: the same entry, else the same index, kept in range. */
export function keptCursor(before: readonly MenuEntry[], cursor: number, next: readonly MenuEntry[]): number {
  const was = before[cursor];
  const same = was === undefined ? -1 : next.findIndex((entry) => entryKey(entry) === entryKey(was));
  return same >= 0 ? same : Math.max(0, Math.min(cursor, next.length - 1));
}

/** The actions that need a number say which place: the menu moves its cursor to the first place of that kind instead. */
const NUMBERED: Readonly<Partial<Record<HerdrAction, PlaceKind>>> = { switch_workspace: "workspace", switch_tab: "tab", focus_agent: "agent" };

/** What choosing entry `at` does: the cursor moves (the menu stays open), or the menu closes with its choice. */
export function chooseEntry(entries: readonly MenuEntry[], at: number): { cursor: number } | { choice: OverlayChoice } | null {
  const entry = entries[at];
  if (entry === undefined) return null;
  if (entry.kind !== "action") return { choice: { kind: "select", target: { kind: entry.kind === "agent" ? "pane" : entry.kind, id: entry.id } } };
  const kind = NUMBERED[entry.action];
  const first = kind === undefined ? -1 : entries.findIndex((candidate) => candidate.kind === kind);
  return first >= 0 ? { cursor: first } : { choice: { kind: "action", action: entry.action } };
}

/** The entry a typed character chooses, by its label; -1 for none. */
export function labelled(entries: readonly MenuEntry[], char: string): number {
  return char === "" ? -1 : entries.findIndex((entry) => entry.label === char);
}

/** The cursor after an arrow key (wrapping round), or null for any other key. */
export function movedCursor(entries: readonly MenuEntry[], cursor: number, event: KeyInput): number | null {
  if (Object.keys(event.mods).length > 0 || entries.length === 0) return null;
  const step = event.key === "ARROW_DOWN" ? 1 : event.key === "ARROW_UP" ? -1 : 0;
  return step === 0 ? null : ((cursor + step) % entries.length + entries.length) % entries.length;
}
