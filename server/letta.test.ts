import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetTranscriptState, paneTranscript, transcriptPage, transcriptToolOutput } from "./conversation.ts";
import { ConversationNotStarted, ConversationUnavailable } from "./conversation-shared.ts";
import * as herdr from "./herdr/client.ts";
import { LettaUnavailable, lettaToolOutput, parseLettaTranscript } from "./letta.ts";
import { lettaBinding, lettaOpenedSessions, lettaSessionOf, lettaTranscriptPath, resolveLettaTranscript } from "./letta-store.ts";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

// Recorded from letta-code 0.34.27 in an isolated herdr session (local backend, herdr's Letta
// integration installed): two turns in the default conversation, then `/new` and two more.
const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "letta", name), "utf8");
const defaultLog = fixture("transcript-default-0.34.27.jsonl");
const newLog = fixture("transcript-conversation-0.34.27.jsonl");
const settingsAfterNew = fixture("settings.local-0.34.27.json");
const AGENT = "agent-local-97f4bceb-2f0d-4a16-8b9f-abb2f3d4a72c";

const pane = (id: string, value: string | null, cwd: string): HerdrPane => ({
  pane_id: id, workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd, foreground_cwd: cwd, agent: "letta", agent_status: "idle",
  ...(value === null ? {} : { agent_session: { agent: "letta", kind: "id", source: "herdr:letta", value } }),
} as HerdrPane);

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "letta-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); forgetTranscriptState(); });

describe("Letta transcript", () => {
  test("reads the prompts, tool calls with their results and answers Letta 0.34.27 recorded", () => {
    const turns = parseLettaTranscript(defaultLog);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[0]).toEqual({ role: "user", ts: "2026-10-29T01:53:05.293Z", parts: [{ kind: "text", text: "Use your shell tool to run: echo fixture-ok && ls. Then reply in one short sentence." }] });
    const [bash, answer] = turns[1]!.parts;
    expect(bash).toMatchObject({ kind: "tool", name: "Bash", input: '{"command":"echo fixture-ok && ls","description":"Run test command to check fixture and list files"}', output: "fixture-ok\n" });
    expect(bash).not.toHaveProperty("error");
    expect(answer).toEqual({ kind: "text", text: "I have successfully run the command and verified the environment." });
    expect(turns[3]!.parts[0]).toMatchObject({ kind: "tool", name: "Read", output: "1\talpha\n2\tbeta\n3\t" });
    expect(turns[3]!.end_ts).toBe("2026-10-29T01:55:05.021Z");
  });

  test("a call Letta recorded as failed is marked so", () => {
    const turns = parseLettaTranscript(newLog);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[3]!.parts[0]).toMatchObject({ kind: "tool", name: "Bash", error: true, output: "Exit code: 1\ncat: missing-file.txt: No such file or directory\n" });
  });

  test("reasoning and errors keep their own kinds", () => {
    const line = (entry: object): string => `${JSON.stringify({ captured_at: "2026-10-29T01:00:00.000Z", source_line_id: "x", ...entry })}\n`;
    const turns = parseLettaTranscript(line({ kind: "user", text: "hi" }) + line({ kind: "reasoning", text: "thinking" }) + line({ kind: "error", text: "rate limited" }));
    expect(turns[1]!.parts).toEqual([{ kind: "thinking", text: "thinking" }, { kind: "notice", text: "rate limited", source: "error" }]);
  });

  test("a transcript in a shape the reader does not know is refused, so the pane uses Terminal", () => {
    expect(() => parseLettaTranscript(`${JSON.stringify({ kind: "summary", text: "x", captured_at: "t" })}\n`)).toThrow(LettaUnavailable);
    expect(() => parseLettaTranscript(`{"kind":"user"\n${defaultLog}`)).toThrow(LettaUnavailable);
    // the last line can be one Letta is still writing
    expect(parseLettaTranscript(`${defaultLog}{"kind":"user","te`)).toHaveLength(4);
    const path = join(root, "transcript.jsonl");
    writeFileSync(path, `${defaultLog}${JSON.stringify({ kind: "tool_call", name: 3, captured_at: "t" })}\n`);
    expect(() => transcriptPage("letta-transcript", path)).toThrow(ConversationUnavailable);
  });

  test("pages at prompts and follows appends as a cold read does", () => {
    const path = join(root, "transcript.jsonl");
    writeFileSync(path, defaultLog);
    const first = transcriptPage("letta-transcript", path);
    expect(first.turns).toHaveLength(4);
    expect(first.metadata).toEqual({ model: null, reasoning_effort: null });
    appendFileSync(path, newLog);
    const live = transcriptPage("letta-transcript", path);
    expect(live.turns).toHaveLength(8);
    expect(live.history_id).toBe(first.history_id);
    forgetTranscriptState();
    expect(transcriptPage("letta-transcript", path).turns).toEqual(live.turns);
  });

  test("the whole output of a call is read by the ref its part carries", () => {
    const path = join(root, "transcript.jsonl");
    const long = "y".repeat(200_000);
    writeFileSync(path, `${JSON.stringify({ kind: "user", text: "go", captured_at: "2026-10-29T01:00:00.000Z", source_line_id: "user-1" })}\n${JSON.stringify({ kind: "tool_call", name: "Bash", argsText: "{}", resultText: long, resultOk: true, captured_at: "2026-10-29T01:00:00.000Z", source_line_id: "Bash-1-1" })}\n`);
    const tool = transcriptPage("letta-transcript", path).turns[1]!.parts[0]!;
    expect(tool).toMatchObject({ kind: "tool", output_ref: "Bash-1-1", output_size: long.length });
    expect(lettaToolOutput(path, "Bash-1-1")).toBe(long);
    expect(transcriptToolOutput("letta-transcript", path, "Bash-1-1")?.startsWith("yyy")).toBe(true);
    expect(lettaToolOutput(path, "Bash-9-9")).toBeNull();
  });
});

describe("Letta conversation binding", () => {
  const opened = lettaOpenedSessions(settingsAfterNew);

  test("reads herdr's report and Letta's record as they were recorded", () => {
    expect(lettaSessionOf(pane("w1:p1", `default:${AGENT}`, root))).toEqual({ reported: `default:${AGENT}`, agent: AGENT, conversation: "default" });
    expect(lettaSessionOf(pane("w1:p1", "local-conv-1", root))).toEqual({ reported: "local-conv-1", agent: null, conversation: "local-conv-1" });
    expect(opened).toEqual([{ agent: AGENT, conversation: "local-conv-1" }]);
  });

  test("binds the conversation both name, taking its agent from Letta's record", () => {
    expect(lettaBinding(lettaSessionOf(pane("w1:p1", "local-conv-1", root))!, opened)).toEqual({ agent: AGENT, conversation: "local-conv-1" });
  });

  test("a report /new left behind binds nothing: herdr kept default while Letta moved to local-conv-1", () => {
    expect(lettaBinding(lettaSessionOf(pane("w1:p1", `default:${AGENT}`, root))!, opened)).toBeNull();
  });

  test("a conversation id two agents' records name, or no record names, binds nothing", () => {
    const session = lettaSessionOf(pane("w1:p1", "local-conv-1", root))!;
    expect(lettaBinding(session, [...opened, { agent: "agent-local-other", conversation: "local-conv-1" }])).toBeNull();
    expect(lettaBinding(session, [])).toBeNull();
    expect(lettaBinding(session, [{ agent: AGENT, conversation: "local-conv-2" }])).toBeNull();
  });

  test("reports of another source, agent or shape are not Letta's", () => {
    const base = pane("w1:p1", "local-conv-1", root);
    for (const agent_session of [
      { agent: "letta", kind: "id", source: "herdr:opencode", value: "local-conv-1" },
      { agent: "claude", kind: "id", source: "herdr:letta", value: "local-conv-1" },
      { agent: "letta", kind: "path", source: "herdr:letta", value: "local-conv-1" },
      { agent: "letta", kind: "id", source: "herdr:letta", value: "../../etc" },
      { agent: "letta", kind: "id", source: "herdr:letta", value: "default:" },
    ]) expect(lettaSessionOf({ ...base, agent_session } as HerdrPane)).toBeNull();
    expect(lettaSessionOf(pane("w1:p1", null, root))).toBeNull();
  });

  test("resolves the project's record, the home folder's global one, and never a conversation two panes report", () => {
    const project = join(root, "proj");
    const config = join(root, "config");
    mkdirSync(join(project, ".letta"), { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(join(project, ".letta", "settings.local.json"), settingsAfterNew);
    const env = { HOME: root, LETTA_CONFIG_DIR: config };
    const reported = pane("w1:p1", "local-conv-1", project);
    expect(resolveLettaTranscript(reported, [reported], env)).toEqual({ path: lettaTranscriptPath(join(config, "transcripts"), AGENT, "local-conv-1"), session: "local-conv-1" });
    expect(resolveLettaTranscript(reported, [reported, pane("w2:p1", "local-conv-1", project)], env)).toBeNull();
    // in a folder with no project record, the global settings stand in
    const home = pane("w1:p1", "local-conv-1", root);
    expect(resolveLettaTranscript(home, [home], env)).toBeNull();
    writeFileSync(join(config, "settings.json"), settingsAfterNew);
    expect(resolveLettaTranscript(home, [home], env)?.path).toBe(lettaTranscriptPath(join(config, "transcripts"), AGENT, "local-conv-1"));
    expect(resolveLettaTranscript(home, [home], { ...env, LETTA_TRANSCRIPT_ROOT: join(root, "elsewhere") })?.path).toBe(lettaTranscriptPath(join(root, "elsewhere"), AGENT, "local-conv-1"));
  });

  test("a bound pane reads its transcript; one not written yet is a conversation not begun; an unbound one uses Terminal", async () => {
    const project = join(root, "proj");
    mkdirSync(join(project, ".letta"), { recursive: true });
    writeFileSync(join(project, ".letta", "settings.local.json"), settingsAfterNew);
    const saved = { config: process.env["LETTA_CONFIG_DIR"], transcripts: process.env["LETTA_TRANSCRIPT_ROOT"] };
    process.env["LETTA_CONFIG_DIR"] = join(root, "config");
    delete process.env["LETTA_TRANSCRIPT_ROOT"];
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async () => ({}) as never);
    const resolve = (target: HerdrPane) => paneTranscript(target.pane_id, undefined, { panes: [target] } as SessionSnapshot);
    try {
      const bound = pane("w1:p1", "local-conv-1", project);
      const path = lettaTranscriptPath(join(root, "config", "transcripts"), AGENT, "local-conv-1");
      await expect(resolve(bound)).rejects.toBeInstanceOf(ConversationNotStarted);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, newLog);
      expect(await resolve(bound)).toEqual({ source: "letta-transcript", path });
      await expect(resolve(pane("w1:p1", `default:${AGENT}`, project))).rejects.toThrow("no_session_path");
      await expect(resolve(pane("w1:p1", null, project))).rejects.toThrow("no_session_path");
    } finally {
      rpc.mockRestore();
      for (const [key, value] of [["LETTA_CONFIG_DIR", saved.config], ["LETTA_TRANSCRIPT_ROOT", saved.transcripts]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});
