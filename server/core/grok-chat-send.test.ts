import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "../herdr/client.ts";
import { GROK_QUEUED_MESSAGE, grokQueuedBehindMessage } from "../../shared/submit-outcome.ts";
import { createSubmitText } from "./composer.ts";

afterEach(() => mock.restore());

/**
 * Chat's immediate send: the composer's Send, and a saved copy's Send now (`sendNow`, its resend).
 * herdr's agent.prompt pastes and sends one Enter. A working Grok queues that Enter. Only Send now
 * then sends one empty-prompt Enter, and only on Grok's empty prompt with the message the one row
 * queued and nothing over it. A plain Send and the terminal's input line stay one Enter.
 */
const submitter = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});

/** Grok's live screen: its output, a dialog when one is up, the input box, the queue footer under it, its shortcuts row. */
function grokScreen(state: { output: string; dialog: boolean; prompt: string; queue: readonly string[] }): string {
  return [
    state.output,
    ...(state.dialog ? ["┌─ Run bash: rm -rf build ─────────┐", "│ ❯ Allow once                      │", "│   Deny            Esc:cancel      │", "└───────────────────────────────────┘"] : []),
    "╭──────────────────────────────────────────╮",
    `│ ❯ ${state.prompt.replace(/\n/g, " ")}`.padEnd(43) + "│",
    "╰──────────────────────────────────────────╯",
    ...(state.queue.length > 0 ? [`  ${state.queue.length} queued, Enter to send now`] : []),
    "  Shift+Tab:mode │ Ctrl+.:shortcuts",
  ].join("\n");
}

/**
 * A stand-in Grok in pane w:p1. Enter on a typed prompt queues it during a turn, and sends it at rest; Enter on its
 * empty prompt sends the top queued row now; Enter in a dialog answers it. `queued`: what the user queued before;
 * `onQueued`: what changes right after the Enter that queued the chat's message.
 */
function grok(options: { status?: string; queued?: string[]; output?: string; onQueued?: (state: GrokState) => void } = {}) {
  const state: GrokState = { status: options.status ?? "working", session: "s1", output: options.output ?? "● Reading the repository", dialog: false, prompt: "", queue: [...options.queued ?? []], sent: [] };
  let queuedOnce = false;
  const enter = () => {
    if (state.dialog) { state.dialog = false; state.sent.push("<dialog answered>"); return; }
    if (state.prompt !== "") {
      if (state.status === "working") state.queue.push(state.prompt);
      else state.sent.push(state.prompt);
      state.prompt = "";
      if (!queuedOnce) { queuedOnce = true; options.onQueued?.(state); }
      return;
    }
    const top = state.queue.shift();
    if (top !== undefined) state.sent.push(top);
  };
  const prompt = spyOn(client, "agentPrompt").mockImplementation(async (_pane, text) => { state.prompt = text; enter(); });
  const typed = spyOn(client, "paneSendText").mockImplementation(async (_pane, text) => { state.prompt = text; });
  const keys = spyOn(client, "paneSendKeys").mockImplementation(async () => { enter(); });
  spyOn(client, "paneRead").mockImplementation(async () => ({ text: grokScreen(state) } as Awaited<ReturnType<typeof client.paneRead>>));
  spyOn(client, "paneGet").mockImplementation(async () => ({
    pane_id: "w:p1", agent: "grok", agent_status: state.status, cwd: "/tmp", terminal_id: "t1",
    agent_session: { kind: "session", source: "herdr:grok", value: state.session },
  } as Awaited<ReturnType<typeof client.paneGet>>));
  return { state, prompt, typed, keys };
}
type GrokState = { status: string; session: string; output: string; dialog: boolean; prompt: string; queue: string[]; sent: string[] };

const sendNow = (text = "hello from chat") => submitter()("w:p1", text, text, Date.now(), false, undefined, undefined, undefined, false, false, true);
const failure = (sent: Promise<void>) => sent.then(() => null, (error: unknown) => error as client.HerdrError);

it("keeps a plain chat Send to a working Grok to the one Enter that queues it", async () => {
  const { state, prompt, typed, keys } = grok();
  await submitter()("w:p1", "hello from chat", "hello from chat", Date.now(), false);
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(typed).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
  expect(state.queue).toEqual(["hello from chat"]);
});

it("leaves Send now queued behind the rows the user queued in Grok before it, and says so", async () => {
  const { state, keys } = grok({ queued: ["row A", "row B"] });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual([]);
  expect(state.queue).toEqual(["row A", "row B", "hello from chat"]);
  expect(failed?.code).toBe("submit_changed");
  expect(failed?.message).toBe(grokQueuedBehindMessage(2));
});

it("presses one more Enter at most, even when Grok's queue footer does not leave", async () => {
  const { keys } = grok();
  keys.mockImplementation(async () => {});
  await sendNow();
  expect(keys).toHaveBeenCalledTimes(1);
});

it("sends a working Grok's queued Send now with one empty-prompt Enter", async () => {
  const { state, prompt, typed, keys } = grok();
  await sendNow();
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(typed).not.toHaveBeenCalled();
  expect(keys).toHaveBeenCalledTimes(1);
  expect(keys).toHaveBeenCalledWith("w:p1", ["Enter"], undefined, expect.any(Function));
  expect(state.sent).toEqual(["hello from chat"]);
});

it("presses nothing into a permission dialog drawn over Grok's queue footer while herdr still reports it working", async () => {
  const { state, keys } = grok({ onQueued: (grok) => { grok.dialog = true; } });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual([]);
  expect(failed?.code).toBe("submit_changed");
  expect(failed?.message).toBe(GROK_QUEUED_MESSAGE);
});

it("presses nothing once herdr reports Grok blocked after the Enter that queued the message", async () => {
  const { state, keys } = grok({ onQueued: (grok) => { grok.status = "blocked"; grok.dialog = true; } });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual([]);
  expect(failed?.message).toBe(GROK_QUEUED_MESSAGE);
});

it("presses nothing when the queue footer's words are only in Grok's output", async () => {
  // Grok took the message at once: nothing is queued, while its output quotes the footer on a line of its own
  const { state, keys } = grok({ output: "  2 queued, Enter to send now", onQueued: (grok) => { grok.sent.push(grok.queue.pop()!); } });
  await sendNow();
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual(["hello from chat"]);
});

it("presses nothing while Grok's prompt holds text typed in the terminal", async () => {
  const { state, keys } = grok({ onQueued: (grok) => { grok.prompt = "git push --force origin ma"; } });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual([]);
  expect(state.prompt).toBe("git push --force origin ma");
  expect(failed?.message).toBe(GROK_QUEUED_MESSAGE);
});

it("presses nothing once the pane holds another Grok session than the send began in", async () => {
  const { state, keys } = grok({ onQueued: (grok) => { grok.session = "s2"; grok.queue = ["row X of the new session"]; } });
  const failed = await failure(sendNow());
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual([]);
  expect(failed?.message).toBe(GROK_QUEUED_MESSAGE);
});

it("sends an idle Grok's chat message with the one Enter inside agent.prompt", async () => {
  const { state, prompt, typed, keys } = grok({ status: "idle" });
  await sendNow();
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(typed).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
  expect(state.sent).toEqual(["hello from chat"]);
});

it("does not send another Enter when Grok's turn ends before the empty prompt is reached", async () => {
  const { prompt, keys } = grok({ onQueued: (grok) => { grok.status = "idle"; } });
  await sendNow();
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(keys).not.toHaveBeenCalled();
});

it("does not paste the chat message again when the empty-prompt Enter fails", async () => {
  const { typed, keys } = grok();
  keys.mockRejectedValue(new client.HerdrError("timeout", "herdr did not answer"));
  const failed = await failure(sendNow());
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect(failed?.code).toBe("submit_changed");
  expect(typed).not.toHaveBeenCalled();
  expect(keys).toHaveBeenCalledTimes(1);
});

it("sends the empty-prompt Enter when agent.prompt refuses and the chat paste fallback runs", async () => {
  const { state, prompt, typed, keys } = grok();
  prompt.mockRejectedValue(new client.HerdrError("agent_not_ready", "not ready"));
  await sendNow();
  expect(typed).toHaveBeenCalledTimes(1);
  expect(keys).toHaveBeenCalledTimes(2);
  expect(state.sent).toEqual(["hello from chat"]);
});

it("reports the chat paste fallback as unconfirmed when the empty-prompt Enter fails", async () => {
  const { prompt, typed, keys } = grok();
  prompt.mockRejectedValue(new client.HerdrError("agent_not_ready", "not ready"));
  const press = keys.getMockImplementation()!;
  let sent = 0;
  keys.mockImplementation(async (...args) => {
    if (++sent === 2) throw new client.HerdrError("submit_timeout", "the message waited too long behind earlier input; nothing was typed");
    await press(...args);
  });
  const failed = await failure(sendNow());
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect(failed?.code).toBe("submit_changed");
  expect(typed).toHaveBeenCalledTimes(1);
});

it("reports the empty-prompt Enter as unconfirmed when the sender may no longer type", async () => {
  const { prompt, typed, keys } = grok();
  let armed = false;
  keys.mockImplementation(async (_pane, _keys, _socket, guard) => {
    armed = true;
    if (typeof guard === "function" && !guard()) throw new client.HerdrError("cancelled", "herdr was not sent");
  });
  const authorize = () => { if (armed) throw new client.HerdrError("read_only", "this connection is in observe mode"); };
  const failed = await failure(submitter()("w:p1", "hello from chat", "hello from chat", Date.now(), false, authorize, undefined, undefined, false, false, true));
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(typed).not.toHaveBeenCalled();
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect(failed?.code).toBe("submit_changed");
});

it("keeps the terminal input line to one Enter while Grok is working", async () => {
  const { prompt, typed, keys } = grok();
  await submitter()("w:p1", "ls", "ls", Date.now(), true);
  expect(prompt).not.toHaveBeenCalled();
  expect(typed).toHaveBeenCalledTimes(1);
  expect(keys).toHaveBeenCalledTimes(1);
  expect(keys).toHaveBeenCalledWith("w:p1", ["Enter"], undefined, expect.any(Function));
});
