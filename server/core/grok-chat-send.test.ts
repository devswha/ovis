import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "../herdr/client.ts";
import { createSubmitText, grokQueueShown, GROK_QUEUE_DRAIN_CAP } from "./composer.ts";

afterEach(() => mock.restore());

/**
 * Chat's immediate send (the composer's Send, a held copy's Send now, the local queue's Send now).
 * herdr's agent.prompt pastes and sends one Enter. A working Grok queues that Enter. Send now then
 * sends an empty-prompt Enter for each row the live screen still shows queued. The terminal's input
 * line stays one Enter.
 */
const submitter = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});

const pane = (status: string) => ({
  pane_id: "w:p1", agent: "grok", agent_status: status, cwd: "/tmp", terminal_id: "t1",
} as Awaited<ReturnType<typeof client.paneGet>>);

function grok(statuses: string[], queuedUntilEnters = 0, queueLine = (left: number) => `${left} queued, Enter to send now`) {
  let read = 0;
  let enters = 0;
  const prompt = spyOn(client, "agentPrompt").mockResolvedValue();
  const typed = spyOn(client, "paneSendText").mockResolvedValue();
  const keys = spyOn(client, "paneSendKeys").mockImplementation(async () => { enters++; });
  spyOn(client, "paneRead").mockImplementation(async () => ({ text: enters < queuedUntilEnters ? queueLine(queuedUntilEnters - enters) : "grok> " } as Awaited<ReturnType<typeof client.paneRead>>));
  spyOn(client, "paneGet").mockImplementation(async () => pane(statuses[Math.min(read++, statuses.length - 1)]!));
  return { prompt, typed, keys };
}

const chat = (text = "hello from chat") => submitter()("w:p1", text, text, Date.now(), false);

it("sends an empty-prompt Enter for each row Grok's queue footer still shows", async () => {
  const { prompt, typed, keys } = grok(["working"], 3);
  await chat();
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(typed).not.toHaveBeenCalled();
  expect(keys.mock.calls.map((call) => call[1])).toEqual([["Enter"], ["Enter"], ["Enter"]]);
});

it("stops draining when Grok's queue footer leaves the live screen", async () => {
  const { keys } = grok(["working"], 1);
  await chat();
  expect(keys).toHaveBeenCalledTimes(1);
});

it("keeps sending while the minimal info row still shows queued rows", async () => {
  const { keys } = grok(["working"], 3, (left) => `grok · ${left} queued · /queue`);
  await chat();
  expect(keys.mock.calls.map((call) => call[1])).toEqual([["Enter"], ["Enter"], ["Enter"]]);
});

it("reads a queued row from the full footer or the minimal info row, not from other text", () => {
  expect(grokQueueShown("2 queued, Enter to send now")).toBe(true);
  expect(grokQueueShown("grok · 2 queued · /queue")).toBe(true);
  expect(grokQueueShown("3 queued jobs")).toBe(false);
  expect(grokQueueShown("1 queued")).toBe(false);
});

it("reports Send now unconfirmed when Grok's queue footer never leaves", async () => {
  const { keys } = grok(["working"], 100);
  const failed = await chat().then(() => null, (error: unknown) => error);
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect((failed as client.HerdrError).code).toBe("submit_changed");
  expect(keys).toHaveBeenCalledTimes(GROK_QUEUE_DRAIN_CAP);
});

it("sends one empty-prompt Enter after agent.prompt queues a working Grok's chat message", async () => {
  const { prompt, typed, keys } = grok(["working"]);
  await chat();
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(typed).not.toHaveBeenCalled();
  expect(keys).toHaveBeenCalledTimes(1);
  expect(keys).toHaveBeenCalledWith("w:p1", ["Enter"], undefined, expect.any(Function));
});

it("sends an idle Grok's chat message with the one Enter inside agent.prompt", async () => {
  const { prompt, typed, keys } = grok(["idle"]);
  await chat();
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(typed).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
});

it("does not send another Enter when Grok's turn ends before the empty prompt is reached", async () => {
  const { prompt, keys } = grok(["working", "working", "idle"]);
  await chat();
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(keys).not.toHaveBeenCalled();
});

it("does not paste the chat message again when the empty-prompt Enter fails", async () => {
  const { typed, keys } = grok(["working"]);
  keys.mockRejectedValue(new client.HerdrError("timeout", "herdr did not answer"));
  const failed = await chat().then(() => null, (error: unknown) => error);
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect((failed as client.HerdrError).code).toBe("submit_changed");
  expect(typed).not.toHaveBeenCalled();
  expect(keys).toHaveBeenCalledTimes(1);
});

it("sends the empty-prompt Enter when agent.prompt refuses and the chat paste fallback runs", async () => {
  const { prompt, typed, keys } = grok(["working"]);
  prompt.mockRejectedValue(new client.HerdrError("agent_not_ready", "not ready"));
  await chat();
  expect(typed).toHaveBeenCalledTimes(1);
  expect(keys.mock.calls.map((call) => call[1])).toEqual([["Enter"], ["Enter"]]);
});

it("reports the chat paste fallback as unconfirmed when the empty-prompt Enter fails", async () => {
  const { prompt, typed, keys } = grok(["working"]);
  prompt.mockRejectedValue(new client.HerdrError("agent_not_ready", "not ready"));
  let sent = 0;
  keys.mockImplementation(async () => { if (++sent === 2) throw new client.HerdrError("submit_timeout", "the message waited too long behind earlier input; nothing was typed"); });
  const failed = await chat().then(() => null, (error: unknown) => error);
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect((failed as client.HerdrError).code).toBe("submit_changed");
  expect(typed).toHaveBeenCalledTimes(1);
});

it("reports the empty-prompt Enter as unconfirmed when the sender may no longer type", async () => {
  const { prompt, typed, keys } = grok(["working"]);
  let armed = false;
  keys.mockImplementation(async (_pane, _keys, _socket, guard) => {
    armed = true;
    if (typeof guard === "function" && !guard()) throw new client.HerdrError("cancelled", "herdr was not sent");
  });
  const authorize = () => { if (armed) throw new client.HerdrError("read_only", "this connection is in observe mode"); };
  const failed = await submitter()("w:p1", "hello from chat", "hello from chat", Date.now(), false, authorize).then(() => null, (error: unknown) => error);
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(typed).not.toHaveBeenCalled();
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect((failed as client.HerdrError).code).toBe("submit_changed");
});

it("keeps the terminal input line to one Enter while Grok is working", async () => {
  const { prompt, typed, keys } = grok(["working"]);
  await submitter()("w:p1", "ls", "ls", Date.now(), true);
  expect(prompt).not.toHaveBeenCalled();
  expect(typed).toHaveBeenCalledTimes(1);
  expect(keys).toHaveBeenCalledTimes(1);
  expect(keys).toHaveBeenCalledWith("w:p1", ["Enter"], undefined, expect.any(Function));
});
