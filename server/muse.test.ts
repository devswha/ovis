import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetTranscriptState, transcriptPage, transcriptToolOutput } from "./conversation.ts";
import { museResult, museToolOutput, parseMuseTranscript } from "./muse.ts";
import { isMuseExecutable, museSessionFor, museSessionLive, parseMuseLock } from "./muse-store.ts";
import type { ConversationPart } from "../shared/protocol.ts";

type Tool = Extract<ConversationPart, { kind: "tool" }>;
const fixture = readFileSync(join(import.meta.dir, "fixtures", "muse", "session.jsonl"), "utf8");
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ovis-muse-unit-")); forgetTranscriptState(); });
afterEach(() => { forgetTranscriptState(); rmSync(root, { recursive: true, force: true }); });

describe("Muse session log", () => {
  test("reads prompts, reasoning, answers, tool results and compaction from the native records", () => {
    const turns = parseMuseTranscript(fixture);
    expect(turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind)])).toEqual([
      ["user", ["text"]],
      ["assistant", ["thinking", "text", "tool", "tool", "tool", "tool", "tool", "text"]],
      ["user", ["text"]],
      ["user", ["compact"]],
      ["assistant", ["text"]],
    ]);
    const [prompt, work] = turns;
    // run/started repeats the prompt; only the accepted intent is the user's message
    expect(prompt!.parts).toEqual([{ kind: "text", text: "Count the lines in notes.txt" }]);
    expect(work!.parts[1]).toEqual({ kind: "text", text: "Counting the lines now.", phase: "commentary" });
    // the run's completed end makes its last answer final
    expect(work!.parts.at(-1)).toEqual({ kind: "text", text: "notes.txt has 3 lines.", phase: "final_answer" });
    const tools = work!.parts.filter((part): part is Tool => part.kind === "tool");
    expect(tools.map((tool) => [tool.name, tool.summary, tool.output.slice(0, 50), tool.error ?? false])).toEqual([
      ["bash", "Count the lines", "3 notes.txt\n", false],
      ["read_file", "notes.txt", "one\ntwo\nthree\n", false],
      ["bash", "Read the missing file", "cat: missing.txt: No such file or directory\n", true],
      ["bash", "Remove the notes", "tool denied: the user declined this command", true],
      ["bash", "Print numbers", Array.from({ length: 20 }, (_, n) => `${n + 1}\n`).join("").slice(0, 50), false],
    ]);
    expect(tools[4]!.output.endsWith("\n… trimmed")).toBe(true);
    expect(JSON.parse(tools[0]!.input)).toEqual({ command: "wc -l notes.txt", description: "Count the lines" });
    expect(tools[4]!.output_ref).toBe("call_05");
    expect(tools[4]!.output_size).toBe(Array.from({ length: 1200 }, (_, n) => `${n + 1}\n`).join("").length);
    expect(turns[3]!.parts[0]).toEqual({ kind: "compact", text: "The user counted the lines of notes.txt: 3." });
    // recorded_at is in microseconds; the answer starts at its first record, the reasoning
    const reasoning = JSON.parse(fixture.split("\n").find((line) => line.includes("reasoning_summary_committed"))!);
    expect(work!.ts).toBe(new Date(Math.floor(reasoning.recorded_at / 1000)).toISOString());
  });

  test("a result whose call is on an earlier page keeps its output on a row of its own", () => {
    const lines = fixture.trimEnd().split("\n");
    const batch = lines.find((line) => line.includes('"call_01"') && line.includes("tool_result_batch_committed"))!;
    const tools = parseMuseTranscript(batch).flatMap((turn) => turn.parts).filter((part): part is Tool => part.kind === "tool");
    expect(tools.map((tool) => [tool.name, tool.output])).toEqual([["Tool output", "3 notes.txt\n"], ["Tool output", "one\ntwo\nthree\n"]]);
    // without an id, a long result is cut with nothing to fetch the rest by
    const unnamed = parseMuseTranscript(batch.replace('"tool_call_id":"call_01"', '"tool_call_id":""').replace("3 notes.txt", "x".repeat(5000)))
      .flatMap((turn) => turn.parts).find((part): part is Tool => part.kind === "tool")!;
    expect([unnamed.output.length < 5000, unnamed.output_ref, unnamed.output_size]).toEqual([true, undefined, undefined]);
  });

  test("only a run that completes on an answer marks it final", () => {
    const lines = fixture.trimEnd().split("\n");
    const last = (log: string[]) => parseMuseTranscript(log.join("\n")).at(-1)!.parts.at(-1);
    const end = lines.findIndex((line) => line.includes('"terminal":"completed"'));
    expect(last(lines.slice(0, end))).toEqual({ kind: "text", text: "notes.txt has 3 lines." });
    expect(last([...lines.slice(0, end), lines[end]!.replace('"terminal":"completed"', '"terminal":"failed"')])).toEqual({ kind: "text", text: "notes.txt has 3 lines." });
    // a run that ends on progress prose or on a tool has no answer to mark
    const commentary = lines.find((line) => line.includes('"phase":"commentary"'))!;
    expect(last([lines[2]!, commentary, lines[end]!])).toEqual({ kind: "text", text: "Counting the lines now.", phase: "commentary" });
    const call = lines.find((line) => line.includes("assistant_tool_calls_committed"))!;
    expect(last([lines[2]!, call, lines[end]!])?.kind).toBe("tool");
  });

  test("unwraps result envelopes and the harness's own verdicts", () => {
    expect(museResult('{"output":"ok","exit_code":0}')).toEqual({ text: "ok", error: false });
    expect(museResult('{"output":"","exit_code":2}')).toEqual({ text: "", error: true });
    expect(museResult('{"status":"done","summary":"found it"}')).toEqual({ text: '{"status":"done","summary":"found it"}', error: false });
    expect(museResult("tool failed: timed out")).toEqual({ text: "tool failed: timed out", error: true });
    expect(museResult("plain text")).toEqual({ text: "plain text", error: false });
  });

  test("pages at prompts, follows appends as a cold read does, and names the latest model", () => {
    const path = join(root, "session.jsonl");
    const lines = fixture.trimEnd().split("\n").map((line) => `${line}\n`);
    const second = lines.findIndex((line, at) => at > 2 && line.includes('"runtime.user_intent.accepted"'));
    writeFileSync(path, lines.slice(0, second).join(""));
    const first = transcriptPage("muse-transcript", path);
    expect(first.source).toBe("muse-transcript");
    expect(first.metadata.model).toBe("muse-fiction-2");
    for (const line of lines.slice(second)) appendFileSync(path, line);
    const live = transcriptPage("muse-transcript", path);
    expect(live.history_id).toBe(first.history_id);
    forgetTranscriptState();
    expect(transcriptPage("muse-transcript", path).turns).toEqual(live.turns);
    expect(live.turns).toEqual(parseMuseTranscript(fixture));
    expect(museToolOutput(path, "call_05")).toBe(Array.from({ length: 1200 }, (_, n) => `${n + 1}\n`).join(""));
    expect(museToolOutput(path, "call_03")).toBe("cat: missing.txt: No such file or directory\n");
    expect(museToolOutput(path, "call_99")).toBeNull();
    // Show all is bounded as for every other agent
    const batch = lines.find((line) => line.includes('"call_02"') && line.includes("tool_result_batch_committed"))!;
    appendFileSync(path, batch.replace('"call_02"', '"call_big"').replace("one\\ntwo\\nthree\\n", "x".repeat(2_000_001)));
    expect(transcriptToolOutput("muse-transcript", path, "call_big")).toBe(`${"x".repeat(2_000_000)}\n… trimmed`);
    expect(transcriptToolOutput("muse-transcript", path, "call_05")).toBe(museToolOutput(path, "call_05"));
  });
});

describe("Muse session binding", () => {
  const start = Date.parse("2026-10-22T12:00:00Z");
  const session = (day: string, id: string, lock: string | null, log = fixture, at = start + 60_000): string => {
    const dir = join(root, "sessions", "2026", "10", day, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl"), log);
    if (lock !== null) {
      writeFileSync(join(dir, ".session.lock"), lock);
      utimesSync(join(dir, ".session.lock"), at / 1000, at / 1000);
    }
    return join(dir, "session.jsonl");
  };
  const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  const END = '{"payload_type":"session.end","payload":{"kind":"session_end"}}\n';
  const ended = `${fixture}${END}`;
  const owner = [{ pid: 4242, startedAt: start }];

  test("binds the one live session whose lock names the process", () => {
    const live = session("22", id(1), "pid=4242\nhost=fiction\n");
    session("22", id(2), "pid=7\nhost=fiction\n");
    session("21", id(3), null);
    expect(museSessionFor(root, owner, "fiction")).toBe(live);
  });

  test("a lock from before the process started, another host's lock, an ended session and a lock without its log never bind", () => {
    session("20", id(1), "pid=4242\nhost=fiction\n", fixture, start - 3_600_000);
    session("22", id(2), "pid=4242\nhost=elsewhere\n");
    session("22", id(3), "pid=4242\nhost=fiction\n", ended);
    rmSync(session("22", id(5), "pid=4242\nhost=fiction\n"));
    expect(museSessionFor(root, owner, "fiction")).toBeNull();
    // after an in-TUI switch, the session left behind ends and the one switched to is live
    const live = session("22", id(4), "pid=4242\nhost=fiction\n");
    expect(museSessionFor(root, owner, "fiction")).toBe(live);
  });

  test("a host name matches by its first label", () => {
    const live = session("22", id(1), "pid=4242\nhost=Fiction\n");
    expect(museSessionFor(root, owner, "fiction.local")).toBe(live);
  });

  test("two live sessions for one process bind neither, and an older lock without a host binds", () => {
    const old = session("22", id(1), "pid=4242\n");
    const other = session("22", id(2), "pid=4242\nhost=fiction\n");
    expect(museSessionFor(root, owner, "fiction")).toBeNull();
    appendFileSync(other, END);
    expect(museSessionFor(root, owner, "fiction")).toBe(old);
  });

  test("keeps a binding while its lock and log hold, and scans again once the log ends", () => {
    const first = session("22", id(1), "pid=4242\nhost=fiction\n");
    expect(museSessionFor(root, owner, "fiction")).toBe(first);
    // a later resolve checks only the bound session: the store is not scanned again
    const second = session("22", id(2), "pid=4242\nhost=fiction\n");
    expect(museSessionFor(root, owner, "fiction")).toBe(first);
    // an in-TUI switch ends the bound log
    appendFileSync(first, END);
    expect(museSessionFor(root, owner, "fiction")).toBe(second);
    // a process that took the pid later never keeps the binding
    expect(museSessionFor(root, [{ pid: 4242, startedAt: start + 3_600_000 }], "fiction")).toBeNull();
  });

  test("a launcher alive beside its muse-bin child binds the session the child holds", () => {
    const live = session("22", id(1), "pid=4242\nhost=fiction\n");
    expect(museSessionFor(root, [{ pid: 4241, startedAt: start }, ...owner], "fiction")).toBe(live);
  });

  test("a store of more than 4096 sessions is not scanned", () => {
    const live = session("22", id(1), "pid=4242\nhost=fiction\n");
    for (let n = 2; n <= 4097; n++) mkdirSync(join(root, "sessions", "2026", "10", "23", id(n)), { recursive: true });
    expect(museSessionFor(root, owner, "fiction")).toBeNull();
    rmSync(join(root, "sessions", "2026", "10", "23", id(4097)), { recursive: true });
    expect(museSessionFor(root, owner, "fiction")).toBe(live);
  });

  test("a subagent's nested session is never a candidate", () => {
    const live = session("22", id(1), "pid=4242\nhost=fiction\n");
    const nested = join(root, "sessions", "2026", "10", "22", id(1), "subagent", id(2));
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, ".session.lock"), "pid=4242\nhost=fiction\n");
    writeFileSync(join(nested, "session.jsonl"), fixture);
    expect(museSessionFor(root, owner, "fiction")).toBe(live);
  });

  test("reads locks, ends and executables as Muse writes them", () => {
    expect(parseMuseLock("pid=10362\nhost=mini\n")).toEqual({ pid: 10362, host: "mini" });
    expect(parseMuseLock("pid=56643\n")).toEqual({ pid: 56643, host: null });
    expect(parseMuseLock("")).toBeNull();
    const path = session("22", id(1), null, ended);
    expect(museSessionLive(path)).toBe(false);
    // a resume writes its records at once, after the end the earlier close left
    appendFileSync(path, '{"payload_type":"session.resumed"');
    expect(museSessionLive(path)).toBe(true);
    expect(museSessionLive(join(root, "missing.jsonl"))).toBe(false);
    for (const name of ["muse", "/Users/a/.local/bin/muse-bin-1.4.12-R6909.1", "C:\\bin\\muse.exe"]) expect(isMuseExecutable(name), name).toBe(true);
    for (const name of ["museum", "muse-helper", "bash"]) expect(isMuseExecutable(name), name).toBe(false);
  });
});
