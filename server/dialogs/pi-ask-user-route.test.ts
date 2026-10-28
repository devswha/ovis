import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiAskBridgeState, PiAskSubmitReply, PiAskSubmitRequest } from "../../shared/pi-ask-bridge.ts";
import type { InteractivePrompt } from "../../shared/protocol.ts";
import { socketAddress } from "../herdr/client.ts";
import { handlePromptRequest, promptWaitEnded } from "../prompt.ts";
import fixture from "../fixtures/pi-ask-user-1.2.0-bridge.json";

const PID = 4242;
const posix = process.platform !== "win32";

interface Bridge {
  state: PiAskBridgeState;
  reply: PiAskSubmitReply;
  submits: PiAskSubmitRequest[];
}

/**
 * A pi pane whose process runs the web UI's extension: a fake herdr RPC endpoint and a fake bridge
 * socket serving the recorded pi-ask 1.2.0 form, both in a temp directory. Never the user's herdr or pi.
 */
async function withBridgedPane(run: (pane: {
  status: string;
  bridge: Bridge;
  session: string;
  root: string;
  read(): Promise<InteractivePrompt | null>;
  answer(id: string, choice: object): Promise<{ status: number; body: { error?: { code: string } } }>;
}) => Promise<void>, options: { bridge?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pau-"));
  const id = `pi-ask-user-${randomUUID()}`;
  const store = join(root, "sessions", "--proj--");
  mkdirSync(store, { recursive: true });
  const session = join(store, "2026-10-28T06-40-21-815Z_268a1f60-5ac8-45fa-8ecc-5a6b3a0ecdd7.jsonl");
  // the session up to the open call; the recorded dismissal is what pi-ask writes once answered
  writeFileSync(session, fixture.transcript.slice(0, 4).map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const bridge: Bridge = { state: { ...fixture.state, pid: PID, sessionFile: session } as PiAskBridgeState, reply: fixture.accepted.reply as PiAskSubmitReply, submits: [] };
  const served = options.bridge === false ? null : (() => {
    mkdirSync(join(root, "herdr-web-ui-ask"), { mode: 0o700 });
    return Bun.serve({
      unix: join(root, "herdr-web-ui-ask", `${PID}.sock`),
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/state") return Response.json(bridge.state);
        bridge.submits.push(await request.json() as PiAskSubmitRequest);
        return Response.json(bridge.reply);
      },
    });
  })();

  const pane = {
    status: "blocked", bridge, session, root,
    read: async (): Promise<InteractivePrompt | null> => {
      const url = new URL(`http://127.0.0.1/api/pane/prompt?pane_id=${id}`);
      const response = (await handlePromptRequest(new Request(url), url))!;
      expect(response.status).toBe(200);
      return (await response.json() as { prompt: InteractivePrompt | null }).prompt;
    },
    answer: async (prompt: string, choice: object) => {
      const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
      const response = (await handlePromptRequest(new Request(url, { method: "POST", body: JSON.stringify({ pane_id: id, prompt_id: prompt, ...choice }) }), url))!;
      return { status: response.status, body: await response.json() as { error?: { code: string } } };
    },
  };
  const sockets = new Set<Socket>();
  const herdr = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.split("\n")[0]!) as { id: string; method: string };
      const reply = (result: unknown) => socket.end(JSON.stringify({ id: request.id, result }) + "\n");
      if (request.method === "session.snapshot") return reply({ snapshot: { panes: [{ pane_id: id, agent: "pi", agent_status: pane.status, terminal_id: id, focused: false }], layouts: [] } });
      if (request.method === "pane.read") return reply({ read: { text: fixture.screen } });
      if (request.method === "pane.get") return reply({ pane: { pane_id: id, scroll: { offset_from_bottom: 0 } } });
      if (request.method === "pane.process_info") return reply({ process_info: { foreground_processes: [{ pid: PID, argv: ["fictional-shell"] }] } });
      if (request.method === "agent.get") return reply({ agent: { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: session } } });
      socket.end(JSON.stringify({ id: request.id, error: { code: "unexpected_fixture_rpc", message: `Unexpected test RPC ${request.method}` } }) + "\n");
    });
  });
  const endpoint = socketAddress(join(root, "herdr.sock"));
  await new Promise<void>((resolve, reject) => { herdr.once("error", reject); herdr.listen(endpoint, resolve); });
  const saved = { socket: process.env["HERDR_SOCKET"], agentDir: process.env["PI_CODING_AGENT_DIR"], store: process.env["PI_CODING_AGENT_SESSION_DIR"] };
  process.env["HERDR_SOCKET"] = endpoint;
  process.env["PI_CODING_AGENT_DIR"] = root;
  delete process.env["PI_CODING_AGENT_SESSION_DIR"];
  const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  try { await run(pane); } finally {
    promptWaitEnded(id);
    restore("HERDR_SOCKET", saved.socket);
    restore("PI_CODING_AGENT_DIR", saved.agentDir);
    restore("PI_CODING_AGENT_SESSION_DIR", saved.store);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => herdr.close(() => resolve()));
    await served?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

test("pi-ask's form is a card, one question per step, and its answers go to pi-ask by value", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    // Given the recorded form open in a pane whose pi runs the extension
    const scope = (await pane.read())!;
    expect(scope).toMatchObject({
      agent: "pi", kind: "question", title: "Release plan", question: "Which part should ship first?", multi_select: false, custom_option_index: 2,
      options: [{ label: "Server (Recommended)", description: "Bridge and prompt route" }, { label: "Client", description: "Card polish only" }, { label: "Type your own answer", description: null }],
      steps: [{ label: "Scope", answered: false, current: true }, { label: "Checks", answered: false, current: false }, { label: "Tone", answered: false, current: false }],
    });
    expect(scope.can_step_back).toBeFalsy();
    // pi-ask never requires an answer; a multi-select's checks and typed text go together
    expect(scope.optional).toBe(true);
    expect(scope.checks_with_text).toBeUndefined();

    // When each step is answered from the card, with one trip back to the first
    expect((await pane.answer(scope.id, { option_index: 0 })).status).toBe(200);
    const checks = (await pane.read())!;
    expect(checks).toMatchObject({ question: "Which checks should run before the push?", multi_select: true, can_step_back: true, checks_with_text: true });
    expect(checks.options.map((option) => option.label)).toEqual(["Unit tests", "Browser QA", "Lint", "Type your own answer"]);
    expect((await pane.answer(checks.id, { option_indices: [0, 1], custom_text: "typecheck" })).status).toBe(200);
    const tone = (await pane.read())!;
    expect(tone.options[0]).toEqual({ label: "Short", description: "Pi's ask_user questions show as chat cards." });
    expect((await pane.answer(tone.id, { step_index: 0 })).status).toBe(200);
    const again = (await pane.read())!;
    expect(again).toMatchObject({ question: "Which part should ship first?", default_option_index: 0 });
    expect((await pane.answer(again.id, { option_index: 0 })).status).toBe(200);
    const checksAgain = (await pane.read())!;
    expect(checksAgain).toMatchObject({ default_option_indices: [0, 1], default_custom_text: "typecheck" });
    expect((await pane.answer(checksAgain.id, { option_indices: [0, 1], custom_text: "typecheck" })).status).toBe(200);
    expect(pane.bridge.submits).toEqual([]);
    const last = (await pane.read())!;
    expect((await pane.answer(last.id, { custom_text: "Plain and short" })).status).toBe(200);

    // Then pi-ask gets every answer at once, exactly as the recorded accepted submit
    expect(pane.bridge.submits).toEqual([{ ...fixture.accepted.request, createdAt: fixture.started.createdAt, sessionFile: pane.session } as PiAskSubmitRequest]);
    // and once pi-ask closes the form (completed, then its dismissal record), the card is gone
    pane.bridge.state = { ...pane.bridge.state, flows: [] };
    appendFileSync(pane.session, JSON.stringify(fixture.transcript[4]) + "\n");
    pane.status = "idle";
    expect(await pane.read()).toBeNull();
  });
});

test("an answer is refused when the card is stale, out of range, or pi-ask turns it down", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    const scope = (await pane.read())!;
    expect((await pane.answer(scope.id, { option_index: 2 })).status).toBe(400);
    expect((await pane.answer(scope.id, { option_indices: [0] })).status).toBe(400);
    expect((await pane.answer(scope.id, { option_index: 1 })).status).toBe(200);
    // the first step's card again, after the answer moved the form on
    expect((await pane.answer(scope.id, { option_index: 1 })).body.error?.code).toBe("prompt_changed");
    await pane.answer((await pane.read())!.id, { option_indices: [2] });

    pane.bridge.reply = fixture.refused.reply as PiAskSubmitReply;
    const tone = (await pane.read())!;
    const refused = await pane.answer(tone.id, { option_index: 1 });
    expect(refused.status).toBe(502);
    expect(refused.body.error?.code).toBe("reply_failed");

    pane.bridge.reply = { ok: false, error: "flow_not_found", message: "Ask flow is not active." };
    expect((await pane.answer((await pane.read())!.id, { option_index: 1 })).body.error?.code).toBe("prompt_changed");
    expect(pane.bridge.submits.map((submit) => submit.response)).toEqual([
      { kind: "answer", mode: "submit", answers: { scope: { values: ["client"] }, checks: { values: ["lint"] }, tone: { values: ["long"] } } },
      { kind: "answer", mode: "submit", answers: { scope: { values: ["client"] }, checks: { values: ["lint"] }, tone: { values: ["long"] } } },
    ]);
  });
});

test("a card's answers never go to a form reopened for the same call", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    // Given a card read up to its last step
    await pane.answer((await pane.read())!.id, { option_index: 0 });
    await pane.answer((await pane.read())!.id, { option_indices: [0] });
    const last = (await pane.read())!;

    // When pi-ask reopens the call's form (same flowId) with other questions before the answer lands
    const flow = pane.bridge.state.flows[0]!;
    pane.bridge.state = { ...pane.bridge.state, flows: [{ ...flow, createdAt: flow.createdAt + 1, questions: [{ ...flow.questions[0]!, prompt: "Ship to production?" }, ...flow.questions.slice(1)] }] };

    // Then the old card's answer is refused and nothing reaches pi-ask
    expect((await pane.answer(last.id, { option_index: 0 })).body.error?.code).toBe("prompt_changed");
    expect(pane.bridge.submits).toEqual([]);
    // and the new form starts over at its first question
    expect(await pane.read()).toMatchObject({ question: "Ship to production?", steps: [{ answered: false, current: true }, { answered: false }, { answered: false }] });
  });
});

test("questions can be skipped, a typed answer survives Back, and an answered question is reachable again", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    // Skip the first question (the card's Skip button sends an empty text)
    expect((await pane.answer((await pane.read())!.id, { custom_text: "" })).status).toBe(200);
    // On the second, type an answer and go Back: the typed text is kept
    const checks = (await pane.read())!;
    expect((await pane.answer(checks.id, { step_back: true, draft: { option_indices: [], custom_text: "typecheck" } })).status).toBe(200);
    const scope = (await pane.read())!;
    expect(scope.steps!.map((step) => step.answered)).toEqual([false, true, false]);
    // and the answered second question is one click away again
    expect((await pane.answer(scope.id, { step_index: 1 })).status).toBe(200);
    expect(await pane.read()).toMatchObject({ question: "Which checks should run before the push?", default_custom_text: "typecheck" });
    // a question not yet answered is not
    expect((await pane.answer((await pane.read())!.id, { step_index: 2 })).status).toBe(400);
    // Skip the rest: pi-ask gets only what was answered
    const second = (await pane.read())!;
    expect((await pane.answer(second.id, { option_indices: [], custom_text: "typecheck" })).status).toBe(200);
    expect((await pane.answer((await pane.read())!.id, { custom_text: "" })).status).toBe(200);
    expect(pane.bridge.submits.map((submit) => submit.response)).toEqual([{ kind: "answer", mode: "submit", answers: { checks: { values: [], customText: "typecheck" } } }]);
  });
});

test("a form pi-ask dropped without telling the extension does not hide the live one", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    const live = pane.bridge.state.flows[0]!;
    // an earlier form whose call is settled in the session: pi-ask disposed it without a completed event
    pane.bridge.state.flows = [{ ...live, flowId: "tool:earlier", toolCallId: "earlier", createdAt: 1 }, live];
    expect(await pane.read()).toMatchObject({ question: "Which part should ship first?" });
  });
});

test("pi-ask's form with no extension is never a card of guessed keys, even while herdr reports it blocked", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    expect(pane.status).toBe("blocked");
    expect(await pane.read()).toBeNull();
  }, { bridge: false });
});

test("no card without every fact the extension and the session agree on", async () => {
  if (!posix) return;
  const unbridged = async (change: (pane: { bridge: Bridge; session: string; root: string }) => void, options?: { bridge?: boolean }) => {
    let prompt: InteractivePrompt | null = null;
    await withBridgedPane(async (pane) => {
      pane.status = "idle";
      change(pane);
      prompt = await pane.read();
    }, options);
    return prompt;
  };
  // the form on screen alone, with no extension: the terminal, as before
  expect(await unbridged(() => undefined, { bridge: false })).toBeNull();
  // another session file than the one herdr reports for the pane
  expect(await unbridged((pane) => { pane.bridge.state.sessionFile = join(pane.root, "other.jsonl"); })).toBeNull();
  // a socket answering for another process
  expect(await unbridged((pane) => { pane.bridge.state.pid = PID + 1; })).toBeNull();
  // two forms at once, each with its call open in the session
  expect(await unbridged((pane) => {
    pane.bridge.state.flows = [pane.bridge.state.flows[0]!, { ...pane.bridge.state.flows[0]!, flowId: "tool:other", toolCallId: "other" }];
    const call = fixture.transcript[2] as { message: { content: { id: string }[] } };
    appendFileSync(pane.session, JSON.stringify({ ...call, message: { ...call.message, content: [{ ...call.message.content[0], id: "other" }] } }) + "\n");
  })).toBeNull();
  // the call already settled in the session file
  expect(await unbridged((pane) => { appendFileSync(pane.session, JSON.stringify(fixture.transcript[4]) + "\n"); })).toBeNull();
  // a socket directory other users can enter: anyone who can write there could speak for pi
  expect(await unbridged((pane) => { chmodSync(join(pane.root, "herdr-web-ui-ask"), 0o755); })).toBeNull();
  // a form with no tool call behind it (pi-ask's /answer and /ask:replay)
  expect(await unbridged((pane) => { pane.bridge.state.flows = [{ ...pane.bridge.state.flows[0]!, toolCallId: undefined }]; })).toBeNull();
});
