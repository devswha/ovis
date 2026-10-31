import { KEY, type ParsedPrompt } from "./shared.ts";

type Tabs = { identity: string; index: number };

/**
 * Switch only native tabs, observing every move; this path never sends text, Enter or Space.
 * `tabsOf` names the form's tab shown: pi's by default, Claude's question tabs (claude.ts) too.
 */
export async function navigatePiAsk(initial: ParsedPrompt, target: number, io: {
  read(): Promise<ParsedPrompt | null>;
  send(key: string): Promise<void>;
  active(): boolean;
  deadline: number;
}, tabsOf: (prompt: ParsedPrompt) => Tabs | undefined = (prompt) => prompt.piAskForm): Promise<boolean> {
  const form = tabsOf(initial);
  if (!form || !Number.isInteger(target) || target < 0 || target === form.index
    || !initial.steps?.[target]?.can_navigate) return false;
  let previous = initial;
  let index = form.index;
  while (index !== target) {
    if (!io.active() || Date.now() >= io.deadline) return false;
    // The request's first read can already be stale; recheck before the first arrow too.
    const before = await io.read();
    if (!before || tabsOf(before)?.identity !== form.identity || tabsOf(before)!.index !== index
      || before.id !== previous.id || !io.active()) return false;
    const direction = target > index ? 1 : -1;
    await io.send(direction === 1 ? KEY.right : KEY.left);
    const expected = index + direction;
    let moved = false;
    while (io.active() && Date.now() < io.deadline) {
      const shown = await io.read();
      if (!shown) return false;
      const tabs = tabsOf(shown);
      // a Claude read whose colors could not be checked (a frame mid-redraw) shows no tab: no evidence
      // either way, so look again; pi's reads stop as before
      if (tabs === undefined) {
        if (initial.claudeTabs === undefined) return false;
        await Bun.sleep(Math.min(50, Math.max(0, io.deadline - Date.now())));
        continue;
      }
      if (tabs.identity !== form.identity) return false;
      if (tabs.index === expected) { previous = shown; index = expected; moved = true; break; }
      if (tabs.index !== index || shown.id !== previous.id) return false;
      await Bun.sleep(Math.min(50, Math.max(0, io.deadline - Date.now())));
    }
    if (!moved) return false;
  }
  return io.active();
}
