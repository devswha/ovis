import { afterAll, beforeAll, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, paneProcessInfo, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { shellQuote } from "./machine-security.ts";
import { processTable } from "./kiro-terminal.ts";
import { tmuxCodexProcess } from "./tmux-terminal.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

// A real private tmux client in the test herdr, a stand-in executable, and synthetic native files.
const native = process.platform === "linux" && Bun.which("tmux") !== null && Bun.which("node") !== null;
const root = mkdtempSync(join(tmpdir(), "ovis-tmux-"));
const socket = join(root, "tmux.sock");
const home = join(root, "store");
const rollout = join(home, "sessions", "rollout-00000000-0000-4000-8000-000000000001.jsonl");
let workspace: string | undefined;
let pane: string;
let wrappedWorkspace: string | undefined;
let wrappedPane: string;
let scriptWorkspace: string | undefined;
let scriptPane: string;
let server: ReturnType<typeof createServer> | undefined;
let tmuxStarted = false;

async function tmux(...args: string[]): Promise<string> {
  const child = Bun.spawn(["tmux", "-S", socket, ...args], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const output = new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(`private tmux command failed: ${error}`);
  return await output;
}

beforeAll(async () => {
  if (!native) return;
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(rollout, [
    { type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000001", cwd: root } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Read my native chat" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Only this native conversation belongs to the selected tmux pane." }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  const executable = join(root, "codex");
  symlinkSync(Bun.which("node")!, executable);
  const ready = join(root, "ready");
  const script = join(root, "holder.cjs");
  writeFileSync(script, `process.title = "codex"; require("fs").openSync(process.argv[2], "r");
    require("fs").writeFileSync(process.argv[3], String(process.pid));
    process.stdout.write("Ask Codex\\nterminal footer chrome\\n");
    process.stdin.on("data", () => process.exit(0)); process.stdin.resume();`);
  const launcher = join(root, "launcher.sh");
  // Keep both shells alive: the foreground sh waits for Codex, and the pane's bash waits for sh.
  writeFileSync(launcher, `set -m\n/bin/sh -c '"$1" "$2" "$3" "$4"; :' fixture ${[executable, script, rollout, ready].map(shellQuote).join(" ")}\n`);
  const watcher = watch(root);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = new Promise<void>((done, fail) => {
    watcher.on("change", (_, file) => { if (file === "ready" && existsSync(ready)) done(); });
    timer = setTimeout(() => fail(new Error("stand-in did not open its rollout")), 5000);
  });
  try {
    tmuxStarted = true;
    await tmux("-f", "/dev/null", "new-session", "-d", "-s", "fixture", `exec env -u BASH_ENV -u ENV CODEX_HOME=${shellQuote(home)} /bin/bash --noprofile --norc ${shellQuote(launcher)}`);
    await started;
  } finally { watcher.close(); clearTimeout(timer); }
  await tmux("set-hook", "-g", "client-attached", "wait-for -S attached");
  const attached = Bun.spawn(["tmux", "-S", socket, "wait-for", "attached"], { stdout: "ignore", stderr: "pipe", timeout: 5000 });
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-tmux-native-chat" });
  workspace = created.workspace.workspace_id;
  pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `exec env -u TMUX tmux -S ${shellQuote(socket)} attach-session -E -t fixture\n` });
  if (await attached.exited !== 0) throw new Error("private tmux client did not attach");
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "idle" });
  const outerChild = join(root, "outer-child.sh");
  const outerRoot = join(root, "outer-root.sh");
  writeFileSync(outerChild, `tmux -S ${shellQuote(socket)} attach-session -E -t fixture; :\n`);
  writeFileSync(outerRoot, `/bin/sh ${shellQuote(outerChild)}; :\n`);
  await tmux("set-hook", "-g", "client-attached", "wait-for -S wrapped-attached");
  const wrappedAttached = Bun.spawn(["tmux", "-S", socket, "wait-for", "wrapped-attached"], { stdout: "ignore", stderr: "pipe", timeout: 5000 });
  const wrapped = await workspaceCreate({ cwd: root, label: "ovis-test-tmux-outer-shells" });
  wrappedWorkspace = wrapped.workspace.workspace_id;
  wrappedPane = wrapped.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: wrappedPane, text: `exec env -u TMUX -u BASH_ENV -u ENV /bin/sh ${shellQuote(outerRoot)}\n` });
  if (await wrappedAttached.exited !== 0) throw new Error("private wrapped tmux client did not attach");
  await herdrRpc("pane.report_agent", { pane_id: wrappedPane, source: "manual", agent: "codex", state: "idle" });
  const scriptDir = join(root, "script");
  mkdirSync(scriptDir);
  const scriptHolder = join(scriptDir, "codex.js");
  writeFileSync(scriptHolder, `require("fs").openSync(process.argv[2], "r");
    require("fs").writeFileSync(process.argv[3], String(process.pid));
    process.stdout.write("Ask Codex\\nterminal footer chrome\\n"); process.stdin.resume();`);
  const scriptReady = join(root, "script-ready");
  const scriptLauncher = join(root, "script-launcher.sh");
  writeFileSync(scriptLauncher, `set -m\n${[Bun.which("node")!, "--no-warnings", scriptHolder, rollout, scriptReady, ""].map(shellQuote).join(" ")}\n`);
  const scriptWatcher = watch(root);
  let scriptTimer: ReturnType<typeof setTimeout> | undefined;
  const scriptStarted = new Promise<void>((done, fail) => {
    scriptWatcher.on("change", (_, file) => { if (file === "script-ready" && existsSync(scriptReady)) done(); });
    scriptTimer = setTimeout(() => fail(new Error("script holder did not open its rollout")), 5000);
  });
  try {
    await tmux("new-session", "-d", "-s", "script", `exec env -u BASH_ENV -u ENV CODEX_HOME=${shellQuote(home)} /bin/bash --noprofile --norc ${shellQuote(scriptLauncher)}`);
    await scriptStarted;
  } finally { scriptWatcher.close(); clearTimeout(scriptTimer); }
  await tmux("set-hook", "-g", "client-attached", "wait-for -S script-attached");
  const scriptAttached = Bun.spawn(["tmux", "-S", socket, "wait-for", "script-attached"], { stdout: "ignore", stderr: "pipe", timeout: 5000 });
  const scriptView = await workspaceCreate({ cwd: root, label: "ovis-test-tmux-script" });
  scriptWorkspace = scriptView.workspace.workspace_id;
  scriptPane = scriptView.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: scriptPane, text: `exec env -u TMUX tmux -S ${shellQuote(socket)} attach-session -E -t script\n` });
  if (await scriptAttached.exited !== 0) throw new Error("private script tmux client did not attach");
  await herdrRpc("pane.report_agent", { pane_id: scriptPane, source: "manual", agent: "codex", state: "idle" });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "app"), codexHome: home });
}, 15_000);

async function cleanup(steps: readonly (() => unknown | Promise<unknown>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try { await step(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Private tmux fixture cleanup failed");
}

afterAll(() => cleanup([
  () => server?.stop(),
  () => workspace ? workspaceClose(workspace) : undefined,
  () => wrappedWorkspace ? workspaceClose(wrappedWorkspace) : undefined,
  () => scriptWorkspace ? workspaceClose(scriptWorkspace) : undefined,
  () => tmuxStarted ? tmux("kill-server") : undefined,
  () => rmSync(root, { recursive: true, force: true }),
]));

it("attempts every own cleanup sequentially and preserves all failures", async () => {
  const stop = new Error("fixture stop failure"), close = new Error("fixture close failure");
  const scriptClose = new Error("fixture script close failure"), kill = new Error("fixture kill failure");
  const calls: string[] = [];
  let failure: unknown;
  try {
    await cleanup([
      () => { calls.push("stop"); throw stop; },
      async () => { calls.push("workspace"); throw close; },
      () => { calls.push("wrapped workspace"); },
      async () => { calls.push("script workspace"); throw scriptClose; },
      () => { calls.push("kill"); throw kill; },
      () => { calls.push("remove"); },
    ]);
  } catch (error) { failure = error; }
  expect(calls).toEqual(["stop", "workspace", "wrapped workspace", "script workspace", "kill", "remove"]);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([stop, close, scriptClose, kill]);
});

it("finishes an error-free cleanup in sequence", async () => {
  const calls: number[] = [];
  await cleanup([async () => { calls.push(1); }, () => { calls.push(2); }]);
  expect(calls).toEqual([1, 2]);
});

it.skipIf(!native)("serves native turns behind a foreground shell launcher instead of its tmux terminal chrome", async () => {
  const pid = Number(readFileSync(join(root, "ready"), "utf8"));
  const rows = await processTable();
  const codex = rows.find((row) => row.pid === pid)!;
  const launcher = rows.find((row) => row.pid === codex.parent)!;
  const rootPid = Number((await tmux("display-message", "-p", "-t", "fixture", "#{pane_pid}")).trim());
  expect(launcher.command).toMatch(/(?:^|\/)sh$/);
  expect(launcher.pid).not.toBe(rootPid);
  expect(launcher.parent).toBe(rootPid);
  expect(codex.group).toBe(launcher.group);
  expect(codex.foreground).toBe(launcher.group);
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/pane/conversation?pane_id=${encodeURIComponent(pane)}`);
  expect(response.status).toBe(200);
  const conversation = await response.json() as ConversationResponse;
  expect(conversation.source).toBe("codex-transcript");
  expect(conversation.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(JSON.stringify(conversation)).toContain("Only this native conversation belongs");
  expect(JSON.stringify(conversation)).not.toContain("terminal footer chrome");
});

it.skipIf(!native)("serves the held native conversation through two live outer shell ancestors", async () => {
  const info = (await paneProcessInfo(wrappedPane))!;
  const rows = await processTable();
  const outer = rows.filter((row) => info.foreground_processes!.some((process) => process.pid === row.pid));
  expect(outer).toHaveLength(3);
  expect(outer.filter((row) => /(?:^|\/)sh$/.test(row.command))).toHaveLength(2);
  const client = outer.find((row) => /tmux/.test(row.command))!;
  const parent = outer.find((row) => row.pid === client.parent)!;
  expect(parent.parent).toBe(info.shell_pid!);
  expect(outer.every((row) => row.group === client.foreground && row.foreground === client.foreground)).toBe(true);
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/pane/conversation?pane_id=${encodeURIComponent(wrappedPane)}`);
  expect(response.status).toBe(200);
  const conversation = await response.json() as ConversationResponse;
  expect(conversation.source).toBe("codex-transcript");
  expect(JSON.stringify(conversation)).toContain("Only this native conversation belongs");
  expect(JSON.stringify(conversation)).not.toContain("terminal footer chrome");
});

it.skipIf(!native)("reads node codex.js argv and its held rollout without a renamed process title", async () => {
  const pid = Number(readFileSync(join(root, "script-ready"), "utf8"));
  expect(basename(readlinkSync(`/proc/${pid}/exe`))).toBe("node");
  expect((await processTable()).find((row) => row.pid === pid)!.command).not.toMatch(/codex/);
  const found = await tmuxCodexProcess(await paneProcessInfo(scriptPane));
  expect(found?.pid).toBe(pid);
  expect(found!.argv).toContain(join(root, "script", "codex.js"));
  expect(found!.argv.at(-1)).toBe("");
  expect(found!.identity).not.toContain(join(root, "script", "codex.js"));
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/pane/conversation?pane_id=${encodeURIComponent(scriptPane)}`);
  expect(response.status).toBe(200);
  const conversation = await response.json() as ConversationResponse;
  expect(conversation.source).toBe("codex-transcript");
  expect(JSON.stringify(conversation)).toContain("Only this native conversation belongs");
  expect(JSON.stringify(conversation)).not.toContain("terminal footer chrome");
});

it.skipIf(!native)("drops native chat for a dead retained pane even while tmux retains its PID and tty", async () => {
  const format = "#{pane_dead}\t#{pane_pid}\t#{pane_tty}";
  const before = (await tmux("display-message", "-p", "-t", "fixture", format)).trim().split("\t");
  expect(before[0]).toBe("0");
  await tmux("set-option", "-w", "-t", "fixture", "remain-on-exit", "on");
  await tmux("set-hook", "-g", "pane-died", "wait-for -S ended");
  const ended = Bun.spawn(["tmux", "-S", socket, "wait-for", "ended"], { stdout: "ignore", stderr: "pipe", timeout: 5000 });
  await tmux("send-keys", "-t", "fixture", "x", "Enter");
  expect(await ended.exited).toBe(0);
  const after = (await tmux("display-message", "-p", "-t", "fixture", format)).trim().split("\t");
  expect(after[0]).toBe("1");
  expect(after.slice(1)).toEqual(before.slice(1));
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/pane/conversation?pane_id=${encodeURIComponent(pane)}`);
  expect(response.status).toBe(200);
  expect((await response.json() as ConversationResponse).source).toBe("scrollback");
});
