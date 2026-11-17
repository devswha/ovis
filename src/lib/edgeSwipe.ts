export const EDGE_PX = 24;
export const SWIPE_PX = 56;
const SLOP_PX = 10;
export const FLING_SPEED = 0.35;
const REST_MS = 100;

export type SwipeVerdict = "open" | "close" | "claim" | "pending" | "ignore";

export function swipeVerdict(drawerOpen: boolean, startX: number, dx: number, dy: number): SwipeVerdict {
  if (!drawerOpen && startX > EDGE_PX) return "ignore";
  if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return "pending";
  if (Math.abs(dy) >= Math.abs(dx)) return "ignore";
  if (!drawerOpen && dx > 0) return dx >= SWIPE_PX ? "open" : "claim";
  if (drawerOpen && dx < 0) return -dx >= SWIPE_PX ? "close" : "claim";
  return "ignore";
}

export function drawerSettles(shown: number, width: number, speed: number): boolean {
  if (speed >= FLING_SPEED) return true;
  if (speed <= -FLING_SPEED) return false;
  return shown > width / 2;
}

const MODAL = "[aria-modal='true']:not(#workspace-drawer), dialog[open]";

function scrolledAside(target: EventTarget | null): boolean {
  for (let node = target as HTMLElement | null; node; node = node.parentElement) {
    if (node.scrollLeft > 0 && node.scrollWidth > node.clientWidth) return true;
  }
  return false;
}

function editable(target: EventTarget | null): boolean {
  for (let node = target as HTMLElement | null; node; node = node.parentElement) {
    if (node.isContentEditable === true || /^(?:INPUT|TEXTAREA|SELECT)$/.test(node.tagName ?? "")) return true;
  }
  return false;
}

function selecting(): boolean {
  const selection = document.getSelection?.() ?? null;
  return selection !== null && !selection.isCollapsed;
}

export function watchDrawerSwipe(isOpen: () => boolean, setOpen: (open: boolean) => void): () => void {
  const narrow = window.matchMedia("(max-width: 768px)");
  let start: { x: number; y: number; open: boolean; at: number } | null = null;
  let claimed = false;
  let done = false;
  let state = false;
  let follow: { drawer: HTMLElement; scrim: HTMLElement | null; width: number; shown: number; x: number; at: number; speed: number } | null = null;
  const onStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    // the last stroke still holds the drawer: a second finger, or its end never came (the element
    // it began on left the page and took its touches with it). It lets go where it was first
    const open = follow !== null ? onEnd() : isOpen();
    start = event.touches.length === 1 && touch && narrow.matches && document.querySelector(MODAL) === null && (open || !scrolledAside(event.target))
      && !editable(event.target) && !selecting()
      ? { x: touch.clientX, y: touch.clientY, open, at: event.timeStamp } : null;
    claimed = false;
    done = false;
    state = open;
    follow = null;
  };
  const onMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (start === null || !touch) return;
    if (!narrow.matches) { onEnd(); return; }
    if (!done && selecting()) { onEnd(); return; }
    const verdict = done ? "claim" : swipeVerdict(start.open, start.x, touch.clientX - start.x, touch.clientY - start.y);
    if (!claimed && verdict === "pending") return;
    if (verdict === "ignore") { onEnd(); return; }
    claimed = true;
    event.preventDefault();
    event.stopPropagation();
    if (!done && (verdict === "open" || verdict === "close")) {
      state = verdict === "open";
      setOpen(state);
      done = true;
    }
    track(touch.clientX - start.x, touch.clientX, event.timeStamp);
  };
  const track = (dx: number, x: number, at: number): void => {
    if (start === null) return;
    if (follow === null) {
      const drawer = document.getElementById?.("workspace-drawer") ?? null;
      if (drawer === null) return;
      const scrim = document.querySelector<HTMLElement>(".scrim");
      const speed = at > start.at ? (x - start.x) / (at - start.at) : 0;
      follow = { drawer, scrim, width: drawer.getBoundingClientRect().width, shown: 0, x, at, speed };
      drawer.style.transition = "none";
      drawer.style.visibility = "visible";
      if (scrim !== null) scrim.style.transition = "none";
    }
    const shown = Math.min(follow.width, Math.max(0, (start.open ? follow.width : 0) + dx));
    if (at > follow.at) follow.speed = (x - follow.x) / (at - follow.at);
    follow.shown = shown;
    follow.x = x;
    follow.at = at;
    follow.drawer.style.transform = `translateX(${shown - follow.width}px)`;
    if (follow.scrim !== null) follow.scrim.style.opacity = String(shown / Math.max(1, follow.width));
  };
  const onEnd = (event?: TouchEvent): boolean => {
    const held = follow;
    start = null;
    claimed = false;
    done = false;
    follow = null;
    if (held === null) return state;
    const rested = event === undefined || event.timeStamp - held.at > REST_MS;
    const open = drawerSettles(held.shown, held.width, rested ? 0 : held.speed);
    if (open !== state) setOpen(open);
    state = open;
    held.drawer.style.transition = "";
    held.drawer.style.visibility = "";
    held.drawer.style.transform = "";
    if (held.scrim !== null) { held.scrim.style.transition = ""; held.scrim.style.opacity = ""; }
    return open;
  };
  document.addEventListener("touchstart", onStart, { capture: true, passive: true });
  document.addEventListener("touchmove", onMove, { capture: true, passive: false });
  document.addEventListener("touchend", onEnd, { capture: true, passive: true });
  document.addEventListener("touchcancel", onEnd, { capture: true, passive: true });
  return () => {
    document.removeEventListener("touchstart", onStart, { capture: true });
    document.removeEventListener("touchmove", onMove, { capture: true });
    document.removeEventListener("touchend", onEnd, { capture: true });
    document.removeEventListener("touchcancel", onEnd, { capture: true });
  };
}
