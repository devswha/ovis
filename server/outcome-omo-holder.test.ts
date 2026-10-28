import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane, PanePromptResponse, SlashCommand } from "../shared/protocol.ts";
import * as client from "./herdr/client.ts";
import * as conversation from "./conversation.ts";
import * as omo from "./omo.ts";
import * as processStart from "./process-start.ts";
import { bindCommandProcess, commandSendFrom, handlePromptRequest, noteSubmitted } from "./prompt.ts";

const roots: string[] = [];
afterEach(() => { mock.restore(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// An argv-silent custom OmO is known by its session holder alone; the bundled Claude SDK child it runs a turn in
// looks like omo by its path and exits when the turn ends, while the OmO and its session stay (#1985).
it("keeps a command's outcome on a custom OmO whose SDK child exits at the end of the turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-outcome-omo-holder-")); roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  const holders = join(agentDir, "sessions", omo.omoSessionFolder(cwd), "session-holders", "sess-1");
  mkdirSync(holders, { recursive: true });
  writeFileSync(join(holders, "41001.json"), JSON.stringify({ pid: 41001, processStartedAtMs: 1_000, cwd }));
  // herdr gives no per-process cwd here (macOS): the pane's own directory places the OmO
  const parent = { pid: 41001, name: "run", argv: ["/opt/team-ai/bin/run"] };
  const sdk = { pid: 41002, name: "claude", argv: ["/opt/node_modules/omo-ai/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"] };
  let foreground: { pid: number; name: string; argv: string[] }[] = [parent, sdk];
  const listed = (pid: number) => foreground.some((entry) => entry.pid === pid);
  // each process runs under one start time while it is listed, and is gone once it is not
  spyOn(processStart, "processStartedAtAsync").mockImplementation(async (pid) => listed(pid) ? 1_000 : null);
  spyOn(processStart, "processStartedAt").mockImplementation((pid) => listed(pid) ? 1_000 : null);
  spyOn(processStart, "processAlive").mockImplementation((pid) => listed(pid));
  spyOn(omo, "processEnviron").mockReturnValue([`OMO_CODING_AGENT_DIR=${agentDir}`]);

  const pane = { pane_id: "outcome-omo-holder", terminal_id: "term", workspace_id: "w", tab_id: "t", focused: false, revision: 0,
    agent: "omo", agent_status: "idle", cwd, agent_session: null } as HerdrPane;
  const info = () => ({ pane_id: pane.pane_id, shell_pid: 41000, foreground_processes: foreground });
  spyOn(client, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture" }));
  spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false } as Awaited<ReturnType<typeof client.paneRead>>);
  spyOn(client, "paneProcessInfo").mockImplementation(async () => info());
  spyOn(client, "herdrRpc").mockImplementation((async (method: string) => {
    if (method === "agent.get") return { agent: pane };
    if (method === "pane.process_info") return { process_info: info() };
    throw new Error(`fixture: unexpected ${method}`);
  }) as typeof client.herdrRpc);
  spyOn(conversation, "readCommandTranscript").mockResolvedValue(null);
  const served = async (): Promise<string[] | undefined> => {
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${pane.pane_id}`);
    return (await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse).outcomes?.map(({ id }) => id);
  };

  const row: SlashCommand = { name: "context", source: "builtin", description: "", forms: [{ match: "bare", interaction: "none" }, { match: "other", interaction: "none" }] };
  const command = commandSendFrom(pane, "omo", [row], "/context");
  if (!command) throw new Error("fixture command was not recorded");
  bindCommandProcess(pane.pane_id, command, info(), pane);
  await command.visibility?.binding;
  noteSubmitted(pane.pane_id, command.text, command);
  expect(command.visibility?.process?.pid).toBe(parent.pid);
  expect(await served()).toEqual([command.id]);

  // the turn ended: the SDK child is gone, the OmO it went to runs on, and herdr reports the session it started
  // (under the label it gives an OmO pane): the send's row is adopted into it
  foreground = [parent];
  expect(await served()).toEqual([command.id]);
  pane.agent_session = { agent: "pi", kind: "path", source: "herdr:pi", value: join(root, "omo-first.jsonl") };
  expect(await served()).toEqual([command.id]);
  expect(await served()).toEqual([command.id]);

  // the OmO itself is gone: its row goes with it
  foreground = [];
  expect(await served()).toBeUndefined();
});
