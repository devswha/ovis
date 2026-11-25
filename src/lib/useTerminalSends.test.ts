import { expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useTerminalSends, type TerminalSendsDeps } from "./useTerminalSends.ts";
import type { SubmitDelivery, SubmitResult } from "./ws.ts";

it.each([
  ["immediate", true, false, 1],
  ["queue", true, false, 0],
  ["hold", true, false, 0],
  ["immediate", false, false, 0],
  ["immediate", true, true, 0],
] as const)("only interrupts a pending Stop on a dispatched immediate submission (%s, available=%s, held=%s)", async (
  delivery: SubmitDelivery, available: boolean, held: boolean, expected: number,
) => {
  const onImmediateSubmit = mock(() => {});
  const submit = mock((): Promise<SubmitResult> | null => available
    ? Promise.resolve({ ok: false, code: "agent_blocked", message: "The agent still has work" })
    : null);
  const pane = `stop-test-${delivery}`;
  const f = () => {};
  const deps = {
    machineId: "local",
    onChatSuggestion: f,
    onImmediateSubmit,
    paneRef: { current: pane },
    draftHeldForRef: { current: held ? pane : null },
    heldRef: { current: false },
    pendingEpochRef: { current: 1 },
    pendingSubmissionsRef: { current: new Set() },
    redrawGreeting: f,
    releaseRef: { current: f },
    secretRef: { current: null },
    sessionRef: { current: { epoch: 1 } },
    setChatSent: f,
    setChatUnsent: f,
    socketRef: { current: { submit } },
    submitRetention: null,
    termRef: { current: { modes: { bracketedPasteMode: false }, scrollToBottom: f } },
  } as unknown as TerminalSendsDeps;
  let send!: ReturnType<typeof useTerminalSends>["submitComposerMessage"];
  function Probe() {
    send = useTerminalSends(deps).submitComposerMessage;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  await send("Follow up", delivery);
  expect(onImmediateSubmit).toHaveBeenCalledTimes(expected);
  expect(submit).toHaveBeenCalledTimes(held ? 0 : 1);
});
