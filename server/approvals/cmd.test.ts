import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PanePromptResponse, PromptAnswer } from "../../shared/protocol.ts";
import { handlePromptRequest } from "../prompt.ts";
import { APPROVAL_ADAPTERS } from "./adapters.ts";
import { ApprovalHub } from "./hub.ts";

// Synthetic examples from command-code@1.93.4 dist/cli.mjs (createAskUserQuestionTool,
// formatModelOutput, answerPermission and the mod host's bind/dispose) and commandcode.ai/docs/mods.
// Not a recorded run: the examples require no account.
const events = readFileSync(join(import.meta.dir, "../fixtures/cmd-1.93.4-mod-events.jsonl"), "utf8").trim().split("\n")
  .map(line => JSON.parse(line));
const root = () => mkdtempSync(join(tmpdir(), "cmd-"));
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });

function setup(connected = true, heldMs?: number) {
  const dir = root();
  let held = Promise.withResolvers<void>();
  const began = Promise.withResolvers<void>();
  const pane = "cmd-pane";
  const turns: string[] = [];
  const hub = new ApprovalHub(join(dir, "h"), APPROVAL_ADAPTERS, {
    chatConnected: id => connected && id === pane, heldMs,
    onHeld: () => held.resolve(), onTurn: (_id, _kind, event) => { turns.push(event.turn); if (event.turn === "began") began.resolve(); },
  });
  cleanup.push(() => { hub.stop(); rmSync(dir, { recursive: true, force: true }); });
  const launch = () => {
    const args = hub.launchArgs("cmd", pane, ["--continue"], "1.93.4");
    expect(args).toEqual(["--mod", expect.any(String), "--continue"]);
    return args![1]!;
  };
  // Invoke the on-disk launch mod from another process, so the relay's sealed parent pid is the
  // mod host's, and session shutdown, unreachability and abandoned cards cross a real socket.
  function run(path: string, rows: readonly unknown[]) {
    const child = Bun.spawn([process.execPath, "-e", `
      const handlers = new Map();
      const add = (n, f) => handlers.set(n, [...handlers.get(n) ?? [], f]);
      (await import(process.argv[1])).default({ hooks: h => Object.entries(h).forEach(([n,f]) => add(n,f)), on: add });
      const replies = [];
      for (const {hook,event} of JSON.parse(await Bun.stdin.text()))
        for (const f of handlers.get(hook) ?? []) replies.push(await f(event));
      console.log(JSON.stringify(replies));`, path], {
      env: { ...process.env, HOME: dir, USERPROFILE: dir, HERDR_ENV: "", HERDR_SOCKET: join(dir, "absent") },
      stdin: new Blob([JSON.stringify(rows)]), stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    cleanup.push(() => { if (child.exitCode === null) child.kill(); });
    return { pid: child.pid, result: (async () => {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(err).toBe("");
      expect(code).toBe(0);
      return JSON.parse(out);
    })() };
  }
  async function card() {
    await held.promise;
    held = Promise.withResolvers<void>();
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${pane}`);
    const response = await handlePromptRequest(new Request(url), url, { approvals: hub });
    const { prompt } = await response!.json() as PanePromptResponse;
    if (!prompt) throw new Error("No Command Code card");
    return prompt;
  }
  async function answer(id: string, fields: Partial<PromptAnswer>) {
    const url = new URL("http://localhost/api/pane/prompt/answer");
    const response = await handlePromptRequest(new Request(url, {
      method: "POST", body: JSON.stringify({ pane_id: pane, prompt_id: id, ...fields }),
    }), url, { approvals: hub });
    return response?.status;
  }
  return { pane, hub, launch, run, card, answer, turns, began: began.promise, disconnect() { connected = false; hub.releaseUnwatched(); } };
}

it("adds no mod for unknown versions, below the floor, another major or safe mode", () => {
  const { hub, pane } = setup();
  for (const version of [null, "1.93.3", "2.0.0"]) expect(hub.launchArgs("cmd", pane, [], version)).toEqual([]);
  expect(hub.launchArgs("cmd", pane, ["--safe-mode"], "1.93.4")).toEqual(["--safe-mode"]);
});

it.each([[0, "allow"], [1, "deny"], [2, null]] as const)("answers permission option %i as data, once", async (index, result) => {
  const s = setup();
  const child = s.run(s.launch(), [events[0], events[1], events[2], events[4], events[5]]);
  const shown = await s.card();
  await s.began;
  expect(s.hub.toldSession(s.pane, "cmd")).toMatchObject({ session: events[0].event.sessionId, pid: child.pid });
  expect(shown.options.map(o => o.label)).toEqual(["Allow once", "Deny", "Answer in terminal"]);
  expect(shown.body).toContain("pwd");
  expect(await s.answer(shown.id, { option_index: 5 })).toBe(400);
  expect(await s.answer(shown.id, { option_index: index })).toBe(200);
  expect(await s.answer(shown.id, { option_index: 0 })).toBe(409);
  expect((await child.result).filter((v: unknown) => v !== null)).toEqual(result ? [result] : []);
  expect(s.turns).toEqual(["began", "ended"]);
  expect(s.hub.toldSession(s.pane)).toBeNull();
});

it("returns the native question result only after every field is answered", async () => {
  const s = setup();
  const child = s.run(s.launch(), [events[3]]);
  const first = await s.card();
  expect(first.question).toBe("Which store?");
  expect(await s.answer(first.id, { option_index: 1 })).toBe(200);
  const next = await s.card();
  expect(next.multi_select).toBe(true);
  expect(await s.answer(first.id, { option_index: 1 })).toBe(409);
  expect(await s.answer(next.id, { option_indices: [0], custom_text: "CSV" })).toBe(200);
  expect(await child.result).toEqual([{ result: events[3].result }]);
});

it("hands an open question back if its last viewer leaves, discarding partial answers", async () => {
  const s = setup();
  const child = s.run(s.launch(), [events[3]]);
  const first = await s.card();
  expect(await s.answer(first.id, { option_index: 0 })).toBe(200);
  const second = await s.card();
  s.disconnect();
  expect(await child.result).toEqual([null]);
  expect(await s.answer(second.id, { option_index: 1 })).toBe(409);
});

it("keeps the terminal's prompt on timeout, without a viewer, or with an unreachable hub", async () => {
  for (const connected of [true, false]) {
    const s = setup(connected, connected ? 30 : undefined);
    const path = s.launch();
    const child = s.run(path, [events[3]]);
    if (connected) {
      const shown = await s.card();
      expect(await child.result).toEqual([null]);
      expect(await s.answer(shown.id, { option_index: 0 })).toBe(409);
    } else expect(await child.result).toEqual([null]);
    const safety = { ...events[2], event: { ...events[2].event, isSafetyPrompt: true } };
    expect(await s.run(path, [safety]).result).toEqual([null]);
    s.hub.stop();
    expect(await s.run(path, [events[2]]).result).toEqual([null]);
  }
});
