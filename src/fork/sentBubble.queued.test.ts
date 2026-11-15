import { expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { paneStorageId } from "../../shared/machines.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import { PendingMessageStore, pendingMessages } from "../lib/pendingMessages.ts";
import { currentWaitingSends, forgetWaitingSends, waitingKey } from "../lib/sentWaiting.ts";
import { useComposerSends, type ComposerSendsDeps } from "../lib/useComposerSends.ts";
import type { HerdrSocket, SubmitResult } from "../lib/ws.ts";

// Animated replies gives an ordinary send its own popping row (fork/sentBubble.ts). A message that
// went out as a queued follow-up, or from a held copy, is a delivery: its waiting line is marked
// `queued` and stays in the footer, so it is never drawn as a send just made from the composer.

function composer(pane: string, answer: SubmitResult, extra: Partial<ComposerSendsDeps> = {}) {
  let actions!: ReturnType<typeof useComposerSends>;
  function Probe() {
    const deps: Partial<ComposerSendsDeps> = {
      agent: "claude", paneId: pane, paneRef: { current: pane }, machineId: "local", queueOwner: paneStorageId("local", pane),
      socketRef: { current: { connected: true } as HerdrSocket }, sessionRef: { current: null }, pendingScopeRef: { current: "scope" },
      heldRef: { current: false }, secretRef: { current: null }, observeRef: { current: false }, draftHeldForRef: { current: null },
      stillOpenRef: { current: null }, stillOpenNotedRef: { current: false }, chatNavigation: { current: 0 }, setChatLocalSend: () => {},
      ended: false, heldByOpenQueue: false, answering: null, answerPending: false, pendingAnswer: null, settings: { autoSendQueued: false },
      knownOutcomes: () => [], inputRowNow: () => "ready", showSentCommand: () => {},
      submitComposerMessage: () => Promise.resolve(answer),
      ...extra,
    };
    actions = useComposerSends(deps as ComposerSendsDeps);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return actions;
}

it("an ordinary send is not a queued delivery", async () => {
  const pane = "queued-mark-ordinary", key = waitingKey("local", pane);
  try {
    expect(await composer(pane, { ok: true }).composerSend("run the tests")).toBe(true);
    const [sent] = currentWaitingSends(key);
    expect(sent).toMatchObject({ text: "run the tests" });
    expect(sent?.queued).toBeUndefined();
  } finally { forgetWaitingSends(key); }
});

it("a queued follow-up the bridge typed at once is marked queued", async () => {
  const pane = "queued-mark-typed-at-once", key = waitingKey("local", pane);
  try {
    const actions = composer(pane, { ok: true, typedNow: true }, {
      agentStatus: "working", inputAtRest: () => false, settings: { autoSendQueued: true },
      submitComposerMessage: (_text, delivery) => { expect(delivery).toBe("queue"); return Promise.resolve({ ok: true, typedNow: true }); },
    });
    expect(await actions.composerSend("then list the tests")).toBe(true);
    expect(currentWaitingSends(key)).toMatchObject([{ text: "then list the tests", queued: true }]);
  } finally { forgetWaitingSends(key); }
});

it("a held copy sent with Send now is marked queued", async () => {
  const data = new Map<string, string>(), storage = paneLifetimes.paneStorage;
  const spies = [
    spyOn(storage, "getItem").mockImplementation((name) => data.get(name) ?? null),
    spyOn(storage, "setItem").mockImplementation((name, value) => { data.set(name, value); }),
    spyOn(storage, "removeItem").mockImplementation((name) => { data.delete(name); }),
  ];
  const pane = "queued-mark-held", owner = paneStorageId("local", pane), key = waitingKey("local", pane);
  const message = { id: "held-mark", request_id: 1, text: "held follow-up", state: "held" as const, created_at: "2026-10-28T00:00:00Z" };
  try {
    new PendingMessageStore(() => storage).accept(owner, message, "earlier");
    pendingMessages.publish(owner, [], [{ id: message.id, outcome: "held", resumed: true, until: Date.now() + 60_000 }], "receipt");
    await composer(pane, { ok: true, typedNow: true }, { pendingScopeRef: { current: "now" } }).actOnPending(message.id, "steer");
    expect(currentWaitingSends(key)).toMatchObject([{ text: "held follow-up", queued: true }]);
  } finally {
    forgetWaitingSends(key);
    pendingMessages.removeCopy(owner, message.id);
    for (const spy of spies) spy.mockRestore();
  }
});
