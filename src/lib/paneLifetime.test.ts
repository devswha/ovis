import { describe, expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { ComposerDraftStore } from "./composerDraft.ts";
import { PaneLifetimes } from "./paneLifetime.ts";

class MemoryStorage implements Storage {
  readonly data = new Map<string, string>();
  /** writes to keys with this prefix throw, as a full or blocked storage does */
  refuse: string | null = null;
  get length(): number { return this.data.size; }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.refuse !== null && key.startsWith(this.refuse)) throw new DOMException("full", "QuotaExceededError");
    this.data.set(key, value);
  }
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

  it("leaves held and unconfirmed chat messages to recovery too, one record per message", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    lifetimes.observe([pc("local", "herdr-a")], title);
    storage.setItem("ovis:pending:w1:p1", JSON.stringify({ version: 1, messages: [{ id: "1", text: "deploy it" }, { id: "2", text: "and tag it" }] }));
    storage.setItem("ovis:queue:w1:p1", "an older queued line");
    lifetimes.observe([pc("local", "herdr-b")], title);
    expect(storage.getItem("ovis:pending:w1:p1")).toBeNull();
    expect(storage.getItem("ovis:queue:w1:p1")).toBeNull();
    expect(lifetimes.unsent().map(({ kind, text }) => `${kind}:${text}`).sort()).toEqual(["pending:an older queued line", "pending:and tag it", "pending:deploy it"]);
  });

  it("never rolls the stored state back to a herdr it outlived, and follows one that came after", () => {
    const storage = new MemoryStorage();
    const ahead = page(storage);
    ahead.observe([pc("local", "herdr-a")], title);
    ahead.observe([pc("local", "herdr-b")], title);
    ahead.paneStorage.setItem(DRAFT, "for herdr-b's pane");
    // a fresh tab handed an older roster: it keeps to the page, herdr-b's text stays where it is
    const stale = page(storage);
    stale.observe([pc("local", "herdr-a")], title);
    expect(storage.getItem(DRAFT)).toBe("for herdr-b's pane");
    expect(stale.paneStorage.getItem(DRAFT)).toBeNull();
    // a tab that missed herdr-b, once the tab that saw it is gone, still follows herdr-c
    stale.observe([pc("local", "herdr-c")], title);
    expect(stale.stored("local")).toBe(true);
    expect(stale.unsent().map(({ text }) => text)).toEqual(["for herdr-b's pane"]);
  });

  it("takes a snapshot without a lifetime from a PC that proved one as no news", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    lifetimes.observe([pc("local", "herdr-a")], title);
    lifetimes.paneStorage.setItem(DRAFT, "still mine");
    lifetimes.observe([pc("local", undefined)], title);
    expect(lifetimes.generation("local")).toBe("herdr-a");
    expect(lifetimes.paneStorage.getItem(DRAFT)).toBe("still mine");
    expect(lifetimes.unsent()).toEqual([]);
  });

  it("keeps text in this page for recovery when storage refuses its record, or refused the edit itself", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    const drafts = new ComposerDraftStore(() => lifetimes.paneStorage);
    lifetimes.onRetire((machineId) => drafts.forget(machineId, lifetimes));
    lifetimes.observe([pc("local", "herdr-a")], title);
    storage.setItem("ovis:terminal-line:w1:p1", "make release");
    storage.refuse = DRAFT;
    drafts.set(DRAFT, "an edit storage refused");
    storage.refuse = "ovis:unsent:";
    lifetimes.observe([pc("local", "herdr-b")], title);
    expect(storage.getItem("ovis:terminal-line:w1:p1")).toBeNull();
    expect(lifetimes.unsent().map(({ kind, text }) => `${kind}:${text}`).sort()).toEqual(["line:make release", "message:an edit storage refused"]);
    lifetimes.discard(lifetimes.unsent()[0]!.id);
    expect(lifetimes.unsent()).toHaveLength(1);
  });

  it("stores what the page kept while storage refused its record once storage takes it on the same herdr, leaving only another tab's text to recovery", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    storage.refuse = "ovis:pane-lifetime:";
    lifetimes.observe([pc("local", "herdr-a", [pane("w1:p1", "api"), pane("w1:p2", "web")])], title);
    expect(lifetimes.stored("local")).toBe(false);
    lifetimes.paneStorage.setItem("ovis:terminal-draft:w1:p1", JSON.stringify({ text: "echo held", at: 1_000 }));
    lifetimes.paneStorage.setItem("ovis:view:w1:p1", "chat");
    lifetimes.paneStorage.setItem("ovis:terminal-line:w1:p2", "typed here");
    // meanwhile another tab kept its own line for that pane under the same herdr
    storage.setItem("ovis:terminal-line:w1:p2", "typed in another tab");
    storage.refuse = null;
    lifetimes.observe([pc("local", "herdr-a", [pane("w1:p1", "api"), pane("w1:p2", "web")])], title);
    expect(lifetimes.stored("local")).toBe(true);
    expect(storage.getItem("ovis:terminal-draft:w1:p1")).toBe(JSON.stringify({ text: "echo held", at: 1_000 }));
    expect(storage.getItem("ovis:view:w1:p1")).toBe("chat");
    expect(storage.getItem("ovis:terminal-line:w1:p2")).toBe("typed in another tab");
    expect(lifetimes.unsent().map(({ kind, text }) => `${kind}:${text}`)).toEqual(["line:typed here"]);
  });

  it("takes a read from a herdr the page already moved on from as stale, not as a herdr to go back to", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    lifetimes.observe([pc("local", "herdr-a")], title);
    lifetimes.paneStorage.setItem(DRAFT, "for herdr a's pane");
    // the PC's connection names the new herdr first (lib/machineSession.ts), without titles
    lifetimes.observe([pc("local", "herdr-b")]);
    lifetimes.paneStorage.setItem(DRAFT, "for herdr b's pane");
    // then a roster read before the replacement arrives
    lifetimes.observe([pc("local", "herdr-a")], title);
    expect(lifetimes.generation("local")).toBe("herdr-b");
    expect(lifetimes.stored("local")).toBe(true);
    expect(storage.getItem(DRAFT)).toBe("for herdr b's pane");
    expect(lifetimes.unsent().map(({ text, pane_title }) => `${pane_title}:${text}`)).toEqual(["api:for herdr a's pane"]);
  });

  it("empties a draft store's copy in the render that names another herdr, and Discard removes recovered text", () => {
    const storage = new MemoryStorage();
    const lifetimes = page(storage);
    const drafts = new ComposerDraftStore(() => lifetimes.paneStorage);
    lifetimes.onRetire((machineId) => drafts.forget(machineId, lifetimes));
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
