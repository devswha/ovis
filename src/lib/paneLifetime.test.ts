import { describe, expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { ComposerDraftStore } from "./composerDraft.ts";
import { PaneLifetimes } from "./paneLifetime.ts";

class MemoryStorage implements Storage {
  readonly data = new Map<string, string>();
  get length(): number { return this.data.size; }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
  clear(): void { this.data.clear(); }
}

const pane = (pane_id: string, label: string): HerdrPane => ({ pane_id, label } as HerdrPane);
const pc = (id: string, lifetime: string | undefined, panes: HerdrPane[] = [pane("w1:p1", "api")]): Machine =>
  ({ id, name: id, snapshot: { panes, ...(lifetime === undefined ? {} : { herdr_lifetime: lifetime }) } as unknown as SessionSnapshot } as Machine);
const title = (item: HerdrPane): string => item.label ?? item.pane_id;
let ids = 0;
const page = (storage: Storage): PaneLifetimes => new PaneLifetimes(() => storage, () => 1_000, () => `id-${++ids}`);

const DRAFT = "ovis:composer-draft:w1:p1";

describe("pane state per herdr lifetime", () => {
  it("keeps a pane's state across server restarts on one herdr, and leaves a replaced herdr's text to recovery", () => {
    const storage = new MemoryStorage();
    storage.setItem(DRAFT, "for the old pane");
    storage.setItem("ovis:view:w1:p1", "chat");
    storage.setItem("ovis:terminal-draft:w1:p1", JSON.stringify({ text: "echo ", at: 1_000 }));
    storage.setItem(`ovis:composer-sending:${DRAFT}`, JSON.stringify({ sent: "x", at: 1_000 }));
    storage.setItem("ovis:terminal-line:remote:pc2:w1%3Ap1", "another PC's line");
    const first = page(storage);
    // what is stored before any lifetime was named stays the pane's
    first.observe([pc("local", "herdr-a")], title);
    expect(first.paneStorage.getItem(DRAFT)).toBe("for the old pane");
    // a server restart on the same herdr: a new page, the same lifetime
    const reloaded = page(storage);
    reloaded.observe([pc("local", "herdr-a")], title);
    expect(reloaded.paneStorage.getItem(DRAFT)).toBe("for the old pane");
    expect(reloaded.paneStorage.getItem("ovis:view:w1:p1")).toBe("chat");
    expect(reloaded.unsent()).toEqual([]);

    reloaded.observe([pc("local", "herdr-b", [pane("w1:p1", "a shell")])], title);
    for (const key of [DRAFT, "ovis:view:w1:p1", "ovis:terminal-draft:w1:p1", `ovis:composer-sending:${DRAFT}`]) {
      expect(reloaded.paneStorage.getItem(key)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    }
    expect(reloaded.unsent().map(({ machine_id, pane_id, pane_title, kind, text }) => ({ machine_id, pane_id, pane_title, kind, text })).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { machine_id: "local", pane_id: "w1:p1", pane_title: "api", kind: "held", text: "echo " },
      { machine_id: "local", pane_id: "w1:p1", pane_title: "api", kind: "message", text: "for the old pane" },
    ]);
    expect(storage.getItem("ovis:terminal-line:remote:pc2:w1%3Ap1")).toBe("another PC's line");
    // the new herdr's panes write where they are read again
    reloaded.paneStorage.setItem(DRAFT, "for the new pane");
    expect(page(storage).paneStorage.getItem(DRAFT)).toBeNull();
    const next = page(storage);
    next.observe([pc("local", "herdr-b")], title);
    expect(next.paneStorage.getItem(DRAFT)).toBe("for the new pane");
  });

  it("keeps a PC whose snapshots name no lifetime in the page: never stored, kept across reconnects, recoverable once one is named", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    lifetimes.observe([pc("local", undefined)], title);
    lifetimes.paneStorage.setItem(DRAFT, "typed under an older bridge");
    lifetimes.paneStorage.setItem("ovis:view:w1:p1", "chat");
    expect([...storage.data.keys()]).toEqual([]);
    lifetimes.observe([pc("local", undefined)], title);
    expect(lifetimes.paneStorage.getItem(DRAFT)).toBe("typed under an older bridge");
    // the PC's server now names its herdr: what was typed before can no longer be told to be its panes'
    lifetimes.observe([pc("local", "herdr-a")], title);
    expect(lifetimes.paneStorage.getItem(DRAFT)).toBeNull();
    expect(lifetimes.unsent().map(({ kind, text }) => ({ kind, text }))).toEqual([{ kind: "message", text: "typed under an older bridge" }]);
  });

  it("leaves the stored state alone in a page that is behind another tab, and keeps that page's own typing for recovery", () => {
    const storage = new MemoryStorage();
    const ahead = page(storage), behind = page(storage);
    for (const tab of [ahead, behind]) tab.observe([pc("local", "herdr-a")], title);
    ahead.observe([pc("local", "herdr-b")], title);
    ahead.observe([pc("local", "herdr-c")], title);
    ahead.paneStorage.setItem(DRAFT, "for herdr-c's pane");
    // still drawing herdr-a's panes, the page behind neither reads nor writes herdr-c's state
    behind.observe([pc("local", "herdr-a")], title);
    expect(behind.paneStorage.getItem(DRAFT)).toBeNull();
    behind.paneStorage.setItem(DRAFT, "typed while behind");
    // nor does a herdr it reaches on its way take the state of the one the other tab is on
    behind.observe([pc("local", "herdr-b")], title);
    expect(storage.getItem(DRAFT)).toBe("for herdr-c's pane");
    behind.observe([pc("local", "herdr-c")], title);
    expect(behind.paneStorage.getItem(DRAFT)).toBe("for herdr-c's pane");
    expect(behind.unsent().map(({ text }) => text)).toEqual(["typed while behind"]);
  });

  it("empties a draft store's copy in the render that names another herdr, and Discard removes recovered text", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    const drafts = new ComposerDraftStore(() => lifetimes.paneStorage);
    lifetimes.onRetire((machineId) => drafts.forget(machineId));
    lifetimes.observe([pc("local", "herdr-a")], title);
    drafts.set(DRAFT, "half a sentence");
    expect(drafts.read(DRAFT).text).toBe("half a sentence");
    lifetimes.observe([pc("local", "herdr-b")], title);
    expect(drafts.read(DRAFT).text).toBe("");
    const [kept] = lifetimes.unsent();
    expect(kept?.text).toBe("half a sentence");
    lifetimes.discard(kept!.id);
    expect(lifetimes.unsent()).toEqual([]);
  });
});
