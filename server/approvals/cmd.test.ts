import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { watch } from "node:fs/promises";
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
  const settled = Promise.withResolvers<void>();
  const began = Promise.withResolvers<void>();
  const pane = "cmd-pane";
  const turns: string[] = [];
  const hub = new ApprovalHub(join(dir, "h"), APPROVAL_ADAPTERS, {
    chatConnected: id => connected && id === pane, heldMs,
    onHeld: () => held.resolve(), onSettled: () => settled.resolve(), onTurn: (_id, _kind, event) => { turns.push(event.turn); if (event.turn === "began") began.resolve(); },
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
      process.on("message", name => { for (const f of handlers.get(name) ?? []) f({}); });
      const replies = [];
      for (const {hook,event} of JSON.parse(await Bun.stdin.text()))
        for (const f of handlers.get(hook) ?? []) replies.push(await f(event));
      console.log(JSON.stringify(replies)); process.disconnect();`, path], {
      env: { ...process.env, HOME: dir, USERPROFILE: dir, HERDR_ENV: "", HERDR_SOCKET: join(dir, "absent") },
      ipc() {}, stdin: new Blob([JSON.stringify(rows)]), stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    cleanup.push(() => { if (child.exitCode === null) child.kill(); });
    return { pid: child.pid, emit: (name: string) => child.send(name), result: (async () => {
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
  return { pane, dir, hub, launch, run, card, answer, turns, settled: settled.promise, began: began.promise, disconnect() { connected = false; hub.releaseUnwatched(); } };
}

it("adds no mod for unknown versions, below the floor, another major or safe mode", () => {
  const { hub, pane } = setup();
  for (const version of [null, "1.93.3", "2.0.0"]) expect(hub.launchArgs("cmd", pane, [], version)).toEqual([]);
  expect(hub.launchArgs("cmd", pane, ["--safe-mode"], "1.93.4")).toEqual(["--safe-mode"]);
});

it.each([[0, "allow"], [1, "deny"], [2, null]] as const)("answers permission option %i as data, once", async (index, result) => {
  const s = setup();
  const path = s.launch();
  const child = s.run(path, [events[0], events[1], events[2], events[4], events[5]]);
  const shown = await s.card();
  await s.began;
  expect(s.hub.toldSession(s.pane, "cmd")).toMatchObject({ session: events[0].event.sessionId, pid: child.pid });
  const file = join(s.dir, ".commandcode", "ovis", `${child.pid}.json`);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ sessionId: events[0].event.sessionId, pid: child.pid });
  expect(shown.options.map(o => o.label)).toEqual(["Allow once", "Deny", "Answer in terminal"]);
  expect(shown.body).toContain("pwd");
  expect(await s.answer(shown.id, { option_index: 5 })).toBe(400);
  expect(await s.answer(shown.id, { option_index: index })).toBe(200);
  expect(await s.answer(shown.id, { option_index: 0 })).toBe(409);
  expect((await child.result).filter((v: unknown) => v !== null)).toEqual(result ? [result] : []);
  expect(s.turns).toEqual(["began", "ended"]);
  expect(s.hub.toldSession(s.pane)).toBeNull();
  expect(existsSync(file)).toBe(false);
  expect(readdirSync(join(s.dir, "h")).filter(name => name.endsWith(".key"))).toEqual([]);
  expect(await s.run(path, [events[2]]).result).toEqual([null]);
});

it.each([["interrupted", 2], ["run_end", 3]] as const)("withdraws a pending card on %s", async (name, row) => {
  const s = setup();
  const child = s.run(s.launch(), [events[row]]);
  const shown = await s.card();
  child.emit(name);
  await s.settled;
  expect(await s.answer(shown.id, { option_index: 0 })).toBe(409);
  expect(await child.result).toEqual([null]);
});

it("revokes the key when the mod process exits without SessionEnd", async () => {
  const s = setup();
  const path = s.launch(), folder = join(s.dir, "h");
  const key = readdirSync(folder).find(name => name.endsWith(".key"))!;
  const watching = watch(folder, { signal: AbortSignal.timeout(5_000) });
  const revoked = (async () => { for await (const event of watching) if (event.filename === key && !existsSync(join(folder, key))) break; })();
  await s.run(path, [events[0], events[1]]).result;
  await revoked;
  expect(await s.run(path, [events[2]]).result).toEqual([null]);
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
  expect(next.options.slice(0, 2).map(option => option.description)).toEqual([null, null]);
  expect(await s.answer(next.id, { option_indices: [0], custom_text: "CSV, compact" })).toBe(200);
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
