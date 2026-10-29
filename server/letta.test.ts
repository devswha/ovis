import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetTranscriptState, paneTranscript, transcriptPage, transcriptToolOutput } from "./conversation.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";
import * as herdr from "./herdr/client.ts";
import { LettaUnavailable, lettaToolOutput, parseLettaTranscript } from "./letta.ts";
import { isLettaProcess, type LettaProcess, lettaBinding, lettaOpenedSessions, lettaSessionOf, lettaTranscriptFor, lettaTranscriptHeld, lettaTranscriptPath, parseEnviron, START_WINDOW_MS } from "./letta-store.ts";
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

  test("a field the reader does not know falls back, and a ref the output route refuses is not offered", () => {
    const entry = (fields: object): string => `${JSON.stringify({ kind: "tool_call", name: "Bash", argsText: "{}", captured_at: "2026-10-29T01:00:00.000Z", ...fields })}\n`;
    expect(() => parseLettaTranscript(entry({ result: { text: "must not drop" } }))).toThrow(LettaUnavailable);
    const [part] = parseLettaTranscript(entry({ resultText: "z".repeat(10_000), source_line_id: "x".repeat(154) }))[0]!.parts;
    expect(part).toMatchObject({ kind: "tool" });
    expect(part).not.toHaveProperty("output_ref");
  });
});

describe("Letta conversation binding", () => {
  const opened = lettaOpenedSessions(settingsAfterNew)!;
  /** A project whose Letta record is `settings`, written `at`, and the pane's letta process started `started`. */
  const setup = (settings: string | null, at: number, started: number, env: Record<string, string> = {}): LettaProcess => {
    const cwd = join(root, "proj");
    mkdirSync(join(cwd, ".letta"), { recursive: true });
    if (settings !== null) {
      writeFileSync(join(cwd, ".letta", "settings.local.json"), settings);
      utimesSync(join(cwd, ".letta", "settings.local.json"), at / 1000, at / 1000);
    }
    return { pid: 4242, cwd, startedAt: started, env: { HOME: root, ...env } };
  };
  const now = Date.now();

  test("reads herdr's report, Letta's record and a letta process as they were recorded", () => {
    expect(lettaSessionOf(pane("w1:p1", `default:${AGENT}`, root))).toEqual({ reported: `default:${AGENT}`, agent: AGENT, conversation: "default" });
    expect(lettaSessionOf(pane("w1:p1", "local-conv-1", root))).toEqual({ reported: "local-conv-1", agent: null, conversation: "local-conv-1" });
    expect(opened).toEqual([{ agent: AGENT, conversation: "local-conv-1" }]);
    expect(isLettaProcess(["node", "/home/user/.npm-global/bin/letta", "-m", "openai-compatible/gemini-3.1-flash-lite"])).toBe(true);
    expect(isLettaProcess(["letta"])).toBe(true);
    expect(isLettaProcess(["node", "/srv/app.js"])).toBe(false);
    expect(parseEnviron("HOME=/h\0LETTA_CONFIG_DIR=/c=d\0")).toEqual({ HOME: "/h", LETTA_CONFIG_DIR: "/c=d" });
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
      { agent: "letta", kind: "id", source: "herdr:letta", value: ".." },
      { agent: "letta", kind: "id", source: "herdr:letta", value: "default:.." },
      { agent: "letta", kind: "id", source: "herdr:letta", value: "default:" },
      { agent: "letta", kind: "id", source: "herdr:letta", value: "default" },
    ]) expect(lettaSessionOf({ ...base, agent_session } as HerdrPane)).toBeNull();
    expect(lettaSessionOf(pane("w1:p1", null, root))).toBeNull();
  });

  test("Letta's record speaks for the pane's process only while nothing wrote it after that process started up", () => {
    const reported = (cwd: string) => pane("w1:p1", "local-conv-1", cwd);
    const path = lettaTranscriptPath(join(root, ".letta", "transcripts"), AGENT, "local-conv-1");
    // the record the process resumed from, written before it started, or by it as it started
    let owner = setup(settingsAfterNew, now - 60_000, now);
    expect(lettaTranscriptFor(reported(owner.cwd), [reported(owner.cwd)], owner)).toEqual({ path, session: "local-conv-1" });
    owner = setup(settingsAfterNew, now + 2_000, now);
    expect(lettaTranscriptFor(reported(owner.cwd), [reported(owner.cwd)], owner)?.path).toBe(path);
    // pane A shows another conversation now; a later write (A's own /new, or another letta in the folder) names local-conv-1
    owner = setup(settingsAfterNew, now + START_WINDOW_MS + 1_000, now);
    expect(lettaTranscriptFor(reported(owner.cwd), [reported(owner.cwd)], owner)).toBeNull();
    // another agent's letta in the folder ran /new later: its local-conv-1 is not this pane's
    owner = setup(JSON.stringify({ sessionsByServer: { local: { agentId: "agent-local-b", conversationId: "local-conv-1" } } }), now + 120_000, now);
    expect(lettaTranscriptFor(reported(owner.cwd), [reported(owner.cwd)], owner)).toBeNull();
  });

  test("a missing, malformed or partly unreadable project record binds nothing, whatever the global settings say", () => {
    mkdirSync(join(root, ".letta"), { recursive: true });
    writeFileSync(join(root, ".letta", "settings.json"), settingsAfterNew);
    for (const settings of [null, "{", "[]", JSON.stringify({ sessionsByServer: { a: { agentId: AGENT, conversationId: "local-conv-1" }, b: { agentId: 3 } } })]) {
      rmSync(join(root, "proj"), { recursive: true, force: true });
      const owner = setup(settings, now - 60_000, now);
      expect(lettaTranscriptFor(pane("w1:p1", "local-conv-1", owner.cwd), [], owner)).toBeNull();
    }
  });

  test("the transcript is where the pane's process keeps it, never where this server would", () => {
    const own = setup(settingsAfterNew, now - 60_000, now, { LETTA_TRANSCRIPT_ROOT: join(root, "elsewhere") });
    const target = pane("w1:p1", "local-conv-1", own.cwd);
    expect(lettaTranscriptFor(target, [target], own)?.path).toBe(lettaTranscriptPath(join(root, "elsewhere"), AGENT, "local-conv-1"));
    expect(lettaTranscriptFor(target, [target], { ...own, env: { HOME: root, LETTA_CONFIG_DIR: join(root, "cfg") } })?.path).toBe(lettaTranscriptPath(join(root, "cfg", "transcripts"), AGENT, "local-conv-1"));
    expect(lettaTranscriptFor(target, [target], { ...own, env: { LETTA_TRANSCRIPT_ROOT: "relative" } })).toBeNull();
    expect(lettaTranscriptFor(target, [target], { ...own, env: {} })).toBeNull();
    expect(lettaTranscriptFor(target, [target, pane("w2:p1", "local-conv-1", own.cwd)], own)).toBeNull();
  });

  test("only a regular file at the path Letta derives is read, never one reached through a link", () => {
    const transcripts = join(root, "transcripts");
    const path = lettaTranscriptPath(transcripts, AGENT, "local-conv-1");
    expect(lettaTranscriptHeld(path, transcripts)).toBe(false);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(join(root, "other.jsonl"), defaultLog);
    symlinkSync(join(root, "other.jsonl"), path);
    expect(lettaTranscriptHeld(path, transcripts)).toBe(false);
    rmSync(path);
    symlinkSync(join(root, "loop"), join(root, "loop"));
    symlinkSync(join(root, "loop"), path);
    expect(lettaTranscriptHeld(path, transcripts)).toBe(false);
    rmSync(path);
    writeFileSync(path, newLog);
    expect(lettaTranscriptHeld(path, transcripts)).toBe(true);
    rmSync(join(transcripts, AGENT), { recursive: true });
    mkdirSync(join(root, "real", "local-conv-1"), { recursive: true });
    writeFileSync(join(root, "real", "local-conv-1", "transcript.jsonl"), newLog);
    symlinkSync(join(root, "real"), join(transcripts, AGENT));
    expect(lettaTranscriptHeld(path, transcripts)).toBe(false);
  });

  test("a bound pane reads the transcript its letta process keeps; without one, or unbound, it uses Terminal", async () => {
    const project = join(root, "proj");
    mkdirSync(join(project, ".letta"), { recursive: true });
    writeFileSync(join(project, ".letta", "settings.local.json"), settingsAfterNew);
    const config = join(root, "config");
    // a real process whose own environment names the store, as the pane's letta would
    const child = Bun.spawn(["sleep", "300"], { env: { HOME: root, LETTA_CONFIG_DIR: config, PATH: process.env["PATH"] ?? "" }, cwd: project });
    const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async () => ({
      pane_id: "w1:p1", foreground_processes: [{ pid: child.pid, argv: ["node", "/opt/letta/bin/letta"], cwd: project }],
    }) as never);
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async () => ({}) as never);
    const resolve = (target: HerdrPane) => paneTranscript(target.pane_id, undefined, { panes: [target] } as SessionSnapshot);
    try {
      const bound = pane("w1:p1", "local-conv-1", project);
      const path = lettaTranscriptPath(join(config, "transcripts"), AGENT, "local-conv-1");
      // a conversation with no file here may have turns elsewhere: the terminal shows them
      await expect(resolve(bound)).rejects.toThrow("no_session_path");
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, newLog);
      expect(await resolve(bound)).toEqual({ source: "letta-transcript", path });
      await expect(resolve(pane("w1:p1", `default:${AGENT}`, project))).rejects.toThrow("no_session_path");
      await expect(resolve(pane("w1:p1", null, project))).rejects.toThrow("no_session_path");
    } finally {
      info.mockRestore();
      rpc.mockRestore();
      child.kill();
      await child.exited;
    }
  });
});
