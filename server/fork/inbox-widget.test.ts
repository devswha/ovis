import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane } from "../../shared/protocol.ts";
import type { InboxWidgetRow } from "../../shared/fork/inbox-widget.ts";
import type { PushPayload } from "../../shared/push.ts";
import webpush from "web-push";
import { RELAY_MAX_BODY_BYTES, type PushService } from "../push.ts";
import { InboxWidget, inboxMessage, inboxOrder, shownWords, type LastWords } from "./inbox-widget.ts";

const dirs: string[] = [];
const widgets: InboxWidget[] = [];
afterEach(() => {
  for (const widget of widgets.splice(0)) widget.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const row = (n: string, s: InboxWidgetRow["s"], t: number): InboxWidgetRow => ({ p: n, n, s, t });
const pane = (id: string, status: HerdrPane["agent_status"], extra: Partial<HerdrPane> = {}) =>
  ({ pane_id: id, workspace_id: "w1", agent: "pi", agent_status: status, title: id, ...extra }) as unknown as HerdrPane;

function setup(lastWords?: LastWords) {
  const dir = mkdtempSync(join(tmpdir(), "inbox-widget-"));
  dirs.push(dir);
  const sent: { endpoint: string; message: PushPayload; topic: string }[] = [];
  let gone = new Set<string>();
  const push = {
    async sendQuiet(endpoint: string, message: PushPayload, topic: string) {
      sent.push({ endpoint, message, topic });
      return gone.has(endpoint) ? { ok: false, status: 410, gone: true } : { ok: true };
    },
  } as unknown as PushService;
  let now = 1_000_000_000_000;
  const widget = new InboxWidget(push, { stateDir: dir, now: () => now, ...(lastWords ? { lastWords } : {}) });
  widgets.push(widget);
  return { dir, push, sent, widget, tick: (ms: number) => { now += ms; }, goneFor: (endpoint: string) => { gone = new Set([endpoint]); } };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("inbox widget", () => {
  test("waiting on you first, the longest wait on top; then the latest finished, working and idle", () => {
    const order = inboxOrder([row("idle", "i", 50), row("work", "w", 40), row("done-old", "d", 10), row("wait-new", "b", 30), row("done-new", "d", 20), row("wait-old", "b", 5)]);
    expect(order.map((item) => item.n)).toEqual(["wait-old", "wait-new", "done-new", "done-old", "work", "idle"]);
  });

  test("a digest that would not fit one push drops rows from the end and counts them", () => {
    const rows = Array.from({ length: 80 }, (_, index) => row(`agent number ${index} with a long name`, "i", index));
    const message = inboxMessage(rows, "https://relay.example/v1/push/x", 1);
    expect(JSON.stringify(message).length).toBeLessThanOrEqual(2_700);
    expect(message.inbox!.rows.length + message.inbox!.more).toBe(80);
    expect(message.inbox!.rows[0]!.n).toBe(rows[0]!.n);
    expect(message.pane_id).toBeNull();
  });

  test("multibyte summaries fit the relay after encryption", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ ...row(`agent ${index}`, "b", index), d: "回复".repeat(45) }));
    const message = inboxMessage(rows, "https://relay.example/v1/push/x", 1);
    const { publicKey } = webpush.generateVAPIDKeys();
    const auth = Buffer.alloc(16, 1).toString("base64url");
    const { cipherText } = webpush.encrypt(publicKey, auth, JSON.stringify(message), "aes128gcm");
    expect(cipherText.byteLength).toBeLessThanOrEqual(RELAY_MAX_BODY_BYTES);
    expect(message.inbox!.rows[0]).toEqual(rows[0]!);
    expect(message.inbox!.rows.length + message.inbox!.more).toBe(rows.length);
  });

  test("sends only to a placed widget, at once when placed, with helpers left out", async () => {
    const { sent, widget } = setup();
    widget.panes([pane("p1", "blocked"), pane("p2", "working"), pane("h1", "working", { parent_pane_id: "p2" } as Partial<HerdrPane>)]);
    await flush();
    expect(sent).toHaveLength(0);
    widget.place("https://relay.example/v1/push/a", true);
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.topic).toBe("ovis-inbox");
    expect(sent[0]!.message.inbox!.rows.map((item) => [item.p, item.s])).toEqual([["p1", "b"], ["p2", "w"]]);
    expect(sent[0]!.message.inbox!.endpoint).toBe("https://relay.example/v1/push/a");
  });

  test("a placed widget is remembered across restarts, and one the push service calls gone is forgotten", async () => {
    const { dir, push, sent, widget, goneFor } = setup();
    widget.place("https://relay.example/v1/push/a", true);
    await flush();
    const again = new InboxWidget(push, { stateDir: dir });
    widgets.push(again);
    goneFor("https://relay.example/v1/push/a");
    again.place("https://relay.example/v1/push/a", true);
    await flush();
    await flush();
    const third = new InboxWidget(push, { stateDir: dir });
    widgets.push(third);
    const before = sent.length;
    third.panes([pane("p1", "blocked")]);
    await flush();
    expect(sent.length).toBe(before);
  });

  test("a status change keeps the row's time unless the status moved", () => {
    const { widget, tick } = setup();
    widget.panes([pane("p1", "working")]);
    const first = widget.rows()[0]!.t;
    tick(60_000);
    widget.panes([pane("p1", "working")]);
    expect(widget.rows()[0]!.t).toBe(first);
    widget.status("p1", "blocked");
    expect(widget.rows()[0]).toMatchObject({ s: "b", t: first + 60 });
    widget.ended("p1");
    expect(widget.rows()).toEqual([]);
  });

  test("each row carries its last words as the inbox shows them, read again only for a row that moved or works", async () => {
    const asked: string[][] = [];
    const words: LastWords = async (_machine, paneIds) => { asked.push([...paneIds]); return Object.fromEntries(paneIds.map((id) => [id, id === "p2" ? null : `said by ${id}`])); };
    const { sent, widget, tick } = setup(words);
    widget.panes([pane("p1", "blocked"), pane("p2", "done"), pane("p3", "working")]);
    widget.place("https://relay.example/v1/push/a", true);
    await flush(); await flush();
    expect(sent[0]!.message.inbox!.rows.map((row) => row.d)).toEqual(["said by p1", undefined, "said by p3"]);
    tick(60_000);
    widget.place("https://relay.example/v1/push/a", true);
    await flush(); await flush();
    expect(asked[1]).toEqual(["p3"]);
    expect(sent[1]!.message.inbox!.rows[0]!.d).toBe("said by p1");
  });

  test("a delayed words read cannot send a working row after its blocked update", async () => {
    const first = Promise.withResolvers<Record<string, string>>();
    let reads = 0;
    const { sent, widget, tick } = setup(async () => ++reads === 1 ? first.promise : { p1: "needs you" });
    jest.useFakeTimers();
    try {
      widget.panes([pane("p1", "working")]);
      widget.place("https://relay.example/v1/push/a", true);
      tick(2_000);
      widget.status("p1", "blocked");
      jest.advanceTimersByTime(2_000);
    } finally {
      jest.useRealTimers();
    }
    await flush();
    first.resolve({ p1: "still working" });
    await flush();
    expect(sent.map(({ message }) => message.inbox!.rows[0]!.s)).toEqual(["w", "b"]);
  });

  test("words are one plain line, the user's marked, cut short", () => {
    expect(shownWords({ role: "assistant", text: "## Done: **all** `tests` pass", at: null, asked_at: null })).toBe("Done: all tests pass");
    expect(shownWords({ role: "user", text: "go", at: null, asked_at: null })).toBe("You: go");
    expect(shownWords({ role: "assistant", text: "x".repeat(200), at: null, asked_at: null })!.length).toBe(90);
    expect(shownWords(null)).toBeNull();
  });
});
