import { sheetStep } from "./historyKeys.ts";

interface NavigationApi {
  currentEntry?: { index: number } | null;
  entries(): Array<{ key: string }>;
  traverseTo(key: string): { committed: Promise<unknown> };
}

/**
 * A page in an iframe can add its own history entries (including hash links), so a one-step
 * `history.back()` may only move the frame. Navigation API entries belong to this window.
 */
export function backUnderCurrentEntry(steps = 1): Promise<unknown> | undefined {
  const by = steps + (sheetStep.goingBack(window.history.state) ? 1 : 0);
  const navigation = (window as unknown as { navigation?: NavigationApi }).navigation;
  const index = navigation?.currentEntry?.index ?? 0;
  const below = navigation?.entries()[index - by];
  if (navigation === undefined || below === undefined) { window.history.go(-by); return undefined; }
  const landed = navigation.traverseTo(below.key).committed;
  landed.catch(() => sheetStep.dropped());
  return landed;
}
