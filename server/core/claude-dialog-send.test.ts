import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../herdr/client.ts";
import * as served from "../runtime/capabilities.ts";
import { createSubmitText } from "./composer.ts";

/**
 * A Chat send to a Claude Code pane whose terminal shows a dialog no reader makes out, in its input box's place: herdr
 * still reports the agent idle. Claude's own PID record says what it waits on (2.1.330 writes `status` and
 * `waitingFor` there, as `claude agents --json` reads them).
 */
const linux = process.platform === "linux";
let root: string;
let store: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let calls: { method: string; params: Record<string, unknown> }[];
let screen: string;
let processInfoFails: boolean;
let argv: string[];
let claude: ReturnType<typeof Bun.spawn>;
/** What herdr names in front of the pane; the stand-in Claude by default */
let foreground: () => Record<string, unknown>[];
/** pane.get's scroll; herdr-core reports none */
let scroll: Record<string, number> | undefined;
const others: ReturnType<typeof Bun.spawn>[] = [];

/** The PID record Claude Code 2.1.330 keeps for its process, with what it says it waits on. */
function record(status: string, waitingFor?: string, pid = claude.pid, kind: Record<string, string> = { kind: "interactive" }, sessions = join(store, "sessions")): void {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const procStart = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
  writeFileSync(join(sessions, `${pid}.json`), JSON.stringify({
    pid, sessionId: "00000000-0000-4000-8000-000000000003", cwd: root, procStart, version: "2.1.330", ...kind,
    status, ...(waitingFor === undefined ? {} : { waitingFor }),
  }));
}

/** A process the test starts besides the stand-in Claude, ended after the test. */
function spawned(command: string[], options: Parameters<typeof Bun.spawn>[1] = {}): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn(command, { stdin: "ignore", ...options });
  others.push(child);
  return child;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-claude-dialog-"));
  store = join(root, "claude-config");
  mkdirSync(join(store, "sessions"), { recursive: true });
  // a background session's own Claude: its argv can name `attach` behind options, and it is no attach client
  claude = Bun.spawn(["sleep", "30"], { env: { ...process.env, CLAUDE_CONFIG_DIR: store, CLAUDE_CODE_SESSION_KIND: "bg" }, stdin: "ignore" });
  argv = ["/usr/bin/claude"];
  foreground = () => [{ pid: claude.pid, argv, cwd: root }];
  scroll = undefined;
  calls = [];
  processInfoFails = false;
  socketBefore = process.env["HERDR_SOCKET"];
  const socket = join(root, "herdr.sock");
  process.env["HERDR_SOCKET"] = socket;
  listener = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        if (!socket.data.buffer.includes("\n")) return;
        const request = JSON.parse(socket.data.buffer) as { id: string; method: string; params?: Record<string, unknown> };
        calls.push({ method: request.method, params: request.params ?? {} });
        const id = String(request.params?.["pane_id"] ?? request.params?.["target"] ?? "");
        if (request.method === "pane.process_info" && processInfoFails) {
          socket.end(`${JSON.stringify({ id: request.id, error: { code: "internal_error", message: "timed out" } })}\n`);
          return;
        }
        const result = request.method === "pane.get"
          ? { pane: { pane_id: id, workspace_id: "w", tab_id: "w:t1", terminal_id: id, cwd: root, focused: false, revision: 0, agent: "claude", agent_status: "idle", ...(scroll === undefined ? {} : { scroll }) } }
          : request.method === "pane.process_info" ? { process_info: { pane_id: id, shell_pid: 1, foreground_processes: foreground() } }
          : request.method === "pane.read" ? { read: { text: screen } }
          : request.method === "pane.scroll_info" ? { scroll: { offset: 0, max: 0 } }
          : {};
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(async () => {
  listener.stop(true);
  for (const child of [claude, ...others.splice(0)]) {
    child.kill();
    await child.exited;
  }
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  rmSync(root, { recursive: true, force: true });
});

const submit = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});
const typed = () => calls.filter((call) => ["agent.prompt", "pane.send_text", "pane.send_keys"].includes(call.method));
/** `/add-dir`'s confirmation in the box's place: no rule, no `❯` input, and no hint a reader takes for a menu */
const DIALOG = ["● Reading the project", "", " Add /work/other to this session's folders?", "", "   1. Yes, for this session", "   2. No"].join("\n");
const RULE = "─".repeat(40);

it.skipIf(!linux)("refuses a Chat send while Claude's PID record says it waits on a dialog drawn in its box's place, typing nothing", async () => {
  screen = DIALOG;
  for (const [waitingFor, named] of [["dialog open", "claude"], ["permission prompt", "claude"], ["input needed", "claude"], ["dialog open", "claude --model sonnet attach 7c5dcf5d"]] as const) {
    argv = named.split(" ");
    record("waiting", waitingFor);
    calls = [];
    const refused = await submit()("w:p1", "hello from chat", "hello from chat", Date.now()).catch((error: unknown) => error);
    expect(refused, waitingFor).toBeInstanceOf(HerdrError);
    expect((refused as HerdrError).code, waitingFor).toBe("agent_blocked");
    expect(typed(), waitingFor).toEqual([]);
  }
});

const refusedTyping = async (): Promise<void> => {
  calls = [];
  const refused = await submit()("w:p1", "hello from chat", "hello from chat", Date.now()).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(HerdrError);
  expect((refused as HerdrError).code).toBe("agent_blocked");
  expect(typed()).toEqual([]);
};
const sends = async (): Promise<void> => {
  calls = [];
  await submit()("w:p1", "hello from chat", "hello from chat", Date.now());
  expect(typed().some((call) => call.method === "agent.prompt" && call.params["text"] === "hello from chat")).toBeTrue();
};

it.skipIf(!linux)("reads the record when the only box is above the live screen, where herdr's detection read of a short pane reaches into the history (#4846)", async () => {
  record("waiting", "dialog open");
  const box = ["● Earlier answer", "", RULE, "❯ ", RULE, "  ? for shortcuts"];
  // a 7-row pane: the dialog's rows are the live screen, the box above them an older frame
  scroll = { offset_from_bottom: 0, max_offset_from_bottom: 30, viewport_rows: 7 };
  screen = [...box, DIALOG].join("\n");
  await refusedTyping();
  // blank rows under a short dialog are live rows too: the box above them is still an older one
  screen = [...box, "  Select model", "  1. Default", "", "", "", ""].join("\n");
  await refusedTyping();
  // the box at the live bottom is typed into, whatever the record says
  screen = ["● Reading the project", ...box].join("\n");
  await sends();
});

it.skipIf(!linux)("reads the record of the Claude a herdr-core launcher runs below the process in front (#4846)", async () => {
  const serving = spyOn(served, "capabilities").mockReturnValue(served.HERDR_CORE);
  try {
    // herdr-core names only the job's first process: here a launcher, with Claude its child in the same job
    const launcher = spawned(["bash", "-c", "(exec -a claude sleep 30) & echo $!; wait"], { env: { ...process.env, CLAUDE_CONFIG_DIR: store }, stdout: "pipe" });
    const { value } = await (launcher.stdout as ReadableStream<Uint8Array>).getReader().read();
    const child = Number(new TextDecoder().decode(value).trim());
    foreground = () => [{ pid: launcher.pid, name: "bun", argv: ["bun", "launch.ts"], cwd: root }];
    screen = DIALOG;
    record("waiting", "dialog open", child);
    await refusedTyping();
    record("idle", undefined, child);
    await sends();
  } finally { serving.mockRestore(); }
});

it.skipIf(!linux)("reads the record of the background worker a `claude attach` client shows, which names the job it runs (#4846)", async () => {
  // Claude Code 2.1.330 writes a background session's record with `kind: "bg"` and the `jobId` of its job; an attach client keeps none
  const worker = spawned(["sleep", "30"]);
  argv = ["claude", "attach", "7c5dcf5d"];
  screen = DIALOG;
  record("waiting", "dialog open", worker.pid, { kind: "bg", jobId: "7c5dcf5d" });
  await refusedTyping();
  record("idle", undefined, worker.pid, { kind: "bg", jobId: "7c5dcf5d" });
  await sends();
  // another job's worker says nothing of this one
  record("waiting", "dialog open", worker.pid, { kind: "bg", jobId: "0a1b2c3d" });
  await sends();
});

it.skipIf(!linux)("reads the record in a relative CLAUDE_CONFIG_DIR, which Claude resolves from its working folder (#4846)", async () => {
  const relative = spawned(["sleep", "30"], { cwd: root, env: { ...process.env, CLAUDE_CONFIG_DIR: "claude-config" } });
  foreground = () => [{ pid: relative.pid, argv: ["claude"], cwd: root }];
  screen = DIALOG;
  record("waiting", "dialog open", relative.pid);
  await refusedTyping();
});

it.skipIf(!linux)("sends as before when the pane's processes cannot be read", async () => {
  screen = DIALOG;
  record("waiting", "dialog open");
  processInfoFails = true;
  await submit()("w:p1", "hello from chat", "hello from chat", Date.now());
  expect(typed().some((call) => call.method === "agent.prompt" && call.params["text"] === "hello from chat")).toBeTrue();
});

it.skipIf(!linux)("sends once the record says Claude rests, and over a box the screen shows whatever the record says", async () => {
  screen = DIALOG;
  record("idle");
  await submit()("w:p1", "hello from chat", "hello from chat", Date.now());
  expect(typed().some((call) => call.method === "agent.prompt" && call.params["text"] === "hello from chat")).toBeTrue();
  // a record that has not caught up yet with a dialog closed: the box drawn again is what is typed into
  screen = ["● Done", "", RULE, "❯ ", RULE, "  ? for shortcuts"].join("\n");
  record("waiting", "dialog open");
  calls = [];
  await submit()("w:p1", "again from chat", "again from chat", Date.now());
  expect(typed().some((call) => call.method === "agent.prompt" && call.params["text"] === "again from chat")).toBeTrue();
});
