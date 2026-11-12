import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../herdr/client.ts";
import { createSubmitText } from "./composer.ts";

// An immediate chat send to an agent whose input box is recorded (shared/input-row.ts typedDraft), against the
// real RPC client on a unix socket this test owns; only herdr's answers are synthetic. The screens are real
// `pane.read --format ansi` recordings (src/lib/fixtures-input-rows/README.md).
const FIXTURES = join(import.meta.dir, "../../src/lib/fixtures-input-rows");
const recorded = (path: string): string => readFileSync(join(FIXTURES, path), "utf8");

let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let pane: { agent: string; argv: string[]; offset: number };
let screens: { visible: string; recent: string };
let calls: { method: string; params: Record<string, unknown> }[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-agent-input-"));
  calls = [];
  screens = { visible: "", recent: "" };
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
        const result = request.method === "pane.get" ? { pane: {
          pane_id: "w:p1", workspace_id: "w", tab_id: "w:t1", terminal_id: "t1", cwd: root, focused: false, revision: 0,
          agent: pane.agent, agent_status: "idle", scroll: { max_offset_from_bottom: 50, offset_from_bottom: pane.offset, viewport_rows: 40 },
        } }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: [{ pid: 2147483646, argv: pane.argv, cwd: root }] } }
          : request.method === "pane.read" ? { read: { text: request.params?.["source"] === "recent" ? screens.recent : screens.visible } }
          : request.method === "agent.prompt" ? {}
          : null;
        if (result === null) throw new Error(`unexpected RPC ${request.method}`);
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(() => {
  listener.stop(true);
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  rmSync(root, { recursive: true, force: true });
});

const submit = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
})("w:p1", "hello", "hello", Date.now());

const prompted = (): boolean => calls.some((call) => call.method === "agent.prompt");

async function refused(): Promise<HerdrError> {
  const error = await submit().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HerdrError);
  return error as HerdrError;
}

it.each([
  ["pi", ["pi"], "pi/draft-typed-119.ansi"],
  ["codex", ["codex"], "codex-0.167.0/composer-ultra-draft-100.ansi"],
  ["codex", ["codex"], "codex/mention-closed-120.ansi"],
])("refuses an immediate send to %s over text typed in its input box (%s), typing nothing", async (agent, argv, screen) => {
  pane = { agent, argv, offset: 0 };
  screens.visible = recorded(screen);
  const error = await refused();
  expect(error.code).toBe("input_draft");
  expect(error.message).toBe("The agent's input box in the terminal holds typed text; send or clear it there, then send this message");
  expect(prompted()).toBeFalse();
});

it.each([
  ["pi", ["pi"], "pi/draft-empty-119.ansi"],
  // pi's autocomplete pushes its box up past the footer: the box is not made out, so the send goes as before
  ["pi", ["pi"], "pi/draft-slash-119.ansi"],
  ["codex", ["codex"], "codex-0.167.0/composer-ultra-empty-100.ansi"],
  // an agent without a recorded box is not read at all
  ["letta", ["letta"], "pi/draft-typed-119.ansi"],
])("sends to %s when its box shows no typed text (%s)", async (agent, argv, screen) => {
  pane = { agent, argv, offset: 0 };
  screens.visible = recorded(screen);
  await submit();
  expect(prompted()).toBeTrue();
  if (agent === "letta") expect(calls.some((call) => call.method === "pane.read")).toBeFalse();
});

it("reads the history's last rows when the viewport is scrolled, where the live box is", async () => {
  pane = { agent: "pi", argv: ["pi"], offset: 12 };
  screens.visible = recorded("pi/settings-open-119.ansi");
  screens.recent = recorded("pi/draft-typed-119.ansi");
  expect((await refused()).code).toBe("input_draft");
  expect(calls.find((call) => call.method === "pane.read")?.params).toMatchObject({ source: "recent", format: "ansi", lines: 40 });
  expect(prompted()).toBeFalse();
});
