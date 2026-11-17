export interface StripScroll {
  readonly at: number | null;
  readonly moved: boolean;
}

export const STRIP_AT_REST: StripScroll = { at: null, moved: false };

export function stripScrolled(was: StripScroll, left: number, max: number): StripScroll {
  if (left === was.at) return was;
  if (was.at !== null && left < was.at && left >= max - 1) return { at: left, moved: was.moved };
  return { at: left, moved: true };
}

export function stripPlaced(was: StripScroll, left: number): StripScroll {
  return { at: left, moved: was.moved };
}

export function stripSelected(was: StripScroll): StripScroll {
  return was.moved ? { at: was.at, moved: false } : was;
}
