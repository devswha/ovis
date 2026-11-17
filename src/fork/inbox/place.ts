import { useSyncExternalStore } from "react";

/** What the agent inbox's column shows: its agents, Pull requests or Notes. One place at a time. */
export type Place = "inbox" | "github" | "notes";

let place: Place = "inbox";
const listeners = new Set<() => void>();
const left = new Set<(from: Place) => void>();
export function setPlace(next: Place): void {
  if (next === place) return;
  place = next;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const usePlace = (): Place => useSyncExternalStore(subscribe, () => place, () => "inbox" as Place);

/* A phone opens a place on a history entry of its own, so its Back leaves the place as the arrow does. The entry
   copies the state it stands on (the app's own keys stay) and adds one key; the listener only reads. */
const PLACE_KEY = "ovis:fork-place";
let onEntry = false;
const entryPlace = (): Place | undefined => typeof window === "undefined" ? undefined
  : (window.history.state as Record<string, unknown> | null)?.[PLACE_KEY] as Place | undefined;

/** Open a place: on a phone on an entry of its own. */
export function openPlace(next: Place, phone: boolean): void {
  if (phone && entryPlace() !== next) { window.history.pushState({ ...(window.history.state ?? {}), [PLACE_KEY]: next }, ""); onEntry = true; }
  setPlace(next);
}

/** Back to the agents: the phone's entry is gone back over, so Back and the arrow are one. */
export function closePlace(): void {
  if (onEntry && entryPlace() !== undefined) window.history.back();
  else setPlace("inbox");
}

/** Called when the phone's Back leaves a place, for what it had open to close with it. */
export function onPlaceLeft(listener: (from: Place) => void): () => void {
  left.add(listener);
  return () => { left.delete(listener); };
}

if (typeof window !== "undefined") window.addEventListener("popstate", () => {
  const entered = entryPlace();
  if (entered !== undefined) { onEntry = true; setPlace(entered); return; }
  if (!onEntry) return;
  onEntry = false;
  const from = place;
  setPlace("inbox");
  for (const listener of left) listener(from);
});
