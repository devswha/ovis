import { afterEach, beforeEach, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { CommandOutcome, ConversationTurn } from "../../shared/protocol.ts";
import { Turn } from "../components/ChatView.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { currentWaitingSends, forgetWaitingSends, rememberWaitingSend, settleWaitingSends, waitingKey, type WaitingSend } from "../lib/sentWaiting.ts";
import { useSendMotion } from "./chatPresentation.ts";
import { FORK_DEFAULTS, type ForkSettings } from "./settings.ts";
import { adoptedKey, adoptSend, claimOutcomes, resetSendBubbles, rowIndexOf, rowSendsOf, sendRowKey, sendTurn, useSendPop } from "./sentBubble.ts";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let fork: Partial<ForkSettings> = {};
const mounted: ReactTestRenderer[] = [];
beforeEach(() => {
  for (const name of globals) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const style = { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "", backgroundColor: "" };
  const listen = { addEventListener: () => {}, removeEventListener: () => {} };
  const store = { getItem: (key: string) => key === "ovis:fork-settings" ? JSON.stringify({ ...FORK_DEFAULTS, ...fork }) : null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, localStorage: store },
    document: { ...listen, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  resetSendBubbles();
});
afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => { renderer.unmount(); });
  fork = {};
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  saved.clear();
});

const send = (id: number, pane = "local:p1", text = "fix the test"): WaitingSend => ({ id, pane, text, at: Date.parse("2026-11-01T10:00:00Z"), after: null });
const userTurn = (text: string, ts: string): ConversationTurn => ({ role: "user", ts, parts: [{ kind: "text", text }] });

function row(key: string, turn: ConversationTurn, sendAt?: number): ReactTestRenderer {
  const props = { paneId: "p1", turn, rowKey: key, sendAt, live: false, waiting: false, showThinking: false };
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(createElement(SettingsProvider, { children: createElement(Turn, props) })); });
  mounted.push(renderer);
  return renderer;
}
const update = (renderer: ReactTestRenderer, key: string, turn: ConversationTurn, sendAt?: number): void => {
  const props = { paneId: "p1", turn, rowKey: key, sendAt, live: false, waiting: false, showThinking: false };
  act(() => { renderer.update(createElement(SettingsProvider, { children: createElement(Turn, props) })); });
};
const bubbleClass = (renderer: ReactTestRenderer): string => String(renderer.root.findByType("article").props.className);
const remove = (renderer: ReactTestRenderer): void => { act(() => { renderer.unmount(); }); mounted.splice(mounted.indexOf(renderer), 1); };
/** the send's row drawn once with the setting on, as the chat does before its turn is read */
function drawn(sent: WaitingSend): void {
  fork = { chatMotion: true };
  remove(row(sendRowKey(sent), sendTurn(sent), sent.at));
}

it("a send's row pops once, and stays the same row when its transcript turn replaces it", () => {
  fork = { chatMotion: true };
  const sent = send(1);
  const key = sendRowKey(sent);
  const renderer = row(key, sendTurn(sent), sent.at);
  expect(bubbleClass(renderer)).toContain("chat-turn-pop");
  expect(bubbleClass(renderer)).toContain("chat-turn-sending");
  const article = renderer.root.findByType("article");
  // the transcript's turn takes the row over: same key, so React keeps the element
  update(renderer, key, userTurn(sent.text, "2026-11-01T10:00:01Z"));
  expect(renderer.root.findByType("article")).toBe(article);
  expect(bubbleClass(renderer)).not.toContain("chat-turn-sending");
  expect(bubbleClass(renderer)).toContain("chat-turn-pop");
});

it("a row the list mounts again does not pop", () => {
  fork = { chatMotion: true };
  const sent = send(2);
  const first = row(sendRowKey(sent), sendTurn(sent), sent.at);
  expect(bubbleClass(first)).toContain("chat-turn-pop");
  remove(first);
  const again = row(sendRowKey(sent), userTurn(sent.text, "2026-11-01T10:00:01Z"));
  expect(bubbleClass(again)).not.toContain("chat-turn-pop");
});

it("a turn read from the transcript, never sent from here, does not pop", () => {
  fork = { chatMotion: true };
  expect(bubbleClass(row('["m","p1",null,0,3]', userTurn("an older message", "2026-10-01T10:00:00Z")))).not.toContain("chat-turn-pop");
});

it("with Animated replies off nothing pops", () => {
  const sent = send(3);
  fork = { chatMotion: false };
  const renderer = row(sendRowKey(sent), sendTurn(sent), sent.at);
  expect(bubbleClass(renderer)).not.toContain("chat-turn-pop");
  update(renderer, sendRowKey(sent), userTurn(sent.text, "2026-11-01T10:00:01Z"));
  expect(bubbleClass(renderer)).not.toContain("chat-turn-pop");
});

it("each send keeps its own row: the same words sent from two panes", () => {
  const first = send(5, "m:p1");
  const second = send(6, "m:p2");
  drawn(first); drawn(second);
  adoptSend("m:p1", first, userTurn(first.text, "2026-11-01T10:00:01Z"));
  adoptSend("m:p2", second, userTurn(second.text, "2026-11-01T10:00:01Z"));
  expect(adoptedKey("m:p1", userTurn(first.text, "2026-11-01T10:00:01Z"), new Set())).toBe(sendRowKey(first));
  expect(adoptedKey("m:p2", userTurn(second.text, "2026-11-01T10:00:01Z"), new Set())).toBe(sendRowKey(second));
  // a key is given to one turn only
  const used = new Set<string>();
  expect(adoptedKey("m:p1", userTurn(first.text, "2026-11-01T10:00:01Z"), used)).toBe(sendRowKey(first));
  expect(adoptedKey("m:p1", userTurn(first.text, "2026-11-01T10:00:01Z"), used)).toBeUndefined();
});

it("a send settling on its transcript turn hands the turn its row", () => {
  const key = waitingKey("m", "adopt");
  const at = Date.parse("2026-11-01T10:00:00Z");
  rememberWaitingSend(key, "run the build", at, null);
  drawn(currentWaitingSends(key)[0]!);
  settleWaitingSends(key, [], at + 100, true);
  const turn = userTurn("run the build", new Date(at + 500).toISOString());
  settleWaitingSends(key, [turn], at + 1000, true);
  const adopted = adoptedKey(key, turn, new Set());
  expect(adopted).toStartWith(`send:${key}:`);
  forgetWaitingSends(key);
});

it("a queued delivery is marked and takes no row from its turn", () => {
  const key = waitingKey("m", "queued");
  const at = Date.parse("2026-11-01T10:00:00Z");
  rememberWaitingSend(key, "from the queue", at, null, true);
  expect(currentWaitingSends(key).map((item) => item.queued)).toEqual([true]);
  settleWaitingSends(key, [], at + 100, true);
  const turn = userTurn("from the queue", new Date(at + 500).toISOString());
  settleWaitingSends(key, [turn], at + 1000, true);
  expect(currentWaitingSends(key)).toEqual([]);
  expect(adoptedKey(key, turn, new Set())).toBeUndefined();
  rememberWaitingSend(key, "typed here", at, null);
  expect(currentWaitingSends(key).map((item) => item.queued)).toEqual([undefined]);
  forgetWaitingSends(key);
});

it("the follow on send belongs to Animated replies", () => {
  let calls = 0;
  const Probe = ({ sentKey, enabled }: { sentKey: number; enabled: boolean }) => { useSendMotion(sentKey, () => { calls++; }, enabled); return null; };
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(createElement(Probe, { sentKey: 0, enabled: true })); });
  mounted.push(renderer);
  act(() => { renderer.update(createElement(Probe, { sentKey: 1, enabled: true })); });
  expect(calls).toBe(1);
  act(() => { renderer.update(createElement(Probe, { sentKey: 2, enabled: false })); });
  expect(calls).toBe(1);
});

const outcomeOf = (id: string, text: string): CommandOutcome => ({ id, pane_id: "p1", text, state: "accepted", evidence: [], created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z" });

it("a send owns the outcome the chat had not read as its text left", () => {
  const first = { ...send(1, "m:p1", "@effect apply it"), known: ["old"] };
  const second = { ...send(2, "m:p1", "@effect apply it"), known: ["old"] };
  const outcomes = [outcomeOf("old", "@effect apply it"), outcomeOf("a", "@effect apply it"), outcomeOf("b", "@effect apply it"), outcomeOf("c", "other")];
  // each takes the oldest such outcome no earlier send took; one that was read before is nobody's
  expect([...claimOutcomes([first, second], outcomes)].map(([id, outcome]) => [id, outcome.id])).toEqual([[1, "a"], [2, "b"]]);
  expect(claimOutcomes([first], [outcomeOf("old", "@effect apply it")]).size).toBe(0);
  // a send that left before the chat read any outcome owns none
  expect(claimOutcomes([send(3, "m:p1", "@effect apply it")], outcomes).size).toBe(0);
});

it("a send keeps the outcome ids the chat had read", () => {
  const key = waitingKey("m", "known");
  rememberWaitingSend(key, "@effect apply it", Date.now(), null, false, ["o1"]);
  rememberWaitingSend(key, "no ids", Date.now(), null);
  expect(currentWaitingSends(key).map((item) => item.known)).toEqual([["o1"], undefined]);
  forgetWaitingSends(key);
});

it("a row mounted with Animated replies off does not pop once the setting is turned on", () => {
  const key = sendRowKey(send(7));
  let pops = false;
  const Probe = ({ on }: { on: boolean }) => { pops = useSendPop(key, on); return null; };
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(createElement(Probe, { on: false })); });
  mounted.push(renderer);
  expect(pops).toBe(false);
  act(() => { renderer.update(createElement(Probe, { on: true })); });
  expect(pops).toBe(false);
  // a row that mounts with it on still pops, once, and keeps its class while mounted
  const fresh = sendRowKey(send(8));
  const Fresh = ({ on }: { on: boolean }) => { pops = useSendPop(fresh, on); return null; };
  act(() => { renderer.update(createElement(Fresh, { on: true })); });
  expect(pops).toBe(true);
  act(() => { renderer.update(createElement(Fresh, { on: true })); });
  expect(pops).toBe(true);
});

it("a row that ran its pop does not run it again when the setting goes off and on", () => {
  const key = sendRowKey(send(9));
  const seen: boolean[] = [];
  const Probe = ({ on }: { on: boolean }) => { seen.push(useSendPop(key, on)); return null; };
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(createElement(Probe, { on: true })); });
  mounted.push(renderer);
  act(() => { renderer.update(createElement(Probe, { on: false })); });
  act(() => { renderer.update(createElement(Probe, { on: true })); });
  expect(seen.at(-1)).toBe(false);
  expect(seen.slice(0, 2)).toEqual([true, false]);
});

it("a send made with Animated replies off takes no row key from its turn once it is turned on", () => {
  const key = waitingKey("m", "offsend");
  const at = Date.parse("2026-11-01T10:00:00Z");
  fork = { chatMotion: false };
  rememberWaitingSend(key, "made with it off", at, null);
  settleWaitingSends(key, [], at + 100, true);
  const turn = userTurn("made with it off", new Date(at + 500).toISOString());
  settleWaitingSends(key, [turn], at + 1000, true);
  // the send's row was never drawn: its turn keeps the slot's key, so it never pops
  expect(adoptedKey(key, turn, new Set())).toBeUndefined();
  forgetWaitingSends(key);
});

it("a restored send is retired for good: its bubble stays away once the restored text clears", () => {
  const same = (a: string, b: string): boolean => a.trim() === b.trim();
  const cancelled = send(20, "m:p1", "fix the test");
  const other = send(21, "m:p1", "something else");
  expect(rowSendsOf([cancelled, other], "fix the test", same).map((item) => item.id)).toEqual([21]);
  expect(rowSendsOf([cancelled, other], null, same).map((item) => item.id)).toEqual([21]);
  // a queued delivery is never a row
  expect(rowSendsOf([{ ...other, queued: true }], null, same)).toEqual([]);
});

it("a send's row is found among the list's rows, any other among the slots", () => {
  const timeline = ["a", "outcome:1", "send:m:p1:3"];
  const slots = ["a", "b"];
  expect(rowIndexOf("send:m:p1:3", timeline, slots)).toBe(2);
  expect(rowIndexOf("b", timeline, slots)).toBe(1);
  expect(rowIndexOf("send:m:p1:9", timeline, slots)).toBe(-1);
});
