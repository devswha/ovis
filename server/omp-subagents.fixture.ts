import { afterEach } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetOmpSubagents } from "./omp-subagents.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  forgetOmpSubagents();
});

export const MIN = 60_000;
export const stamp = (at: number): string => new Date(at).toISOString();
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

let sequence = 0;
const record = (type: string, at: number, extra: Record<string, unknown>) => ({ type, id: `r${++sequence}`, parentId: null, timestamp: stamp(at), runtime: { version: "19.1.0" }, ...extra });
const message = (at: number, body: Record<string, unknown>) => record("message", at, { message: body });
const usage = (totalTokens: number) => ({ input: 4, output: 68, cacheRead: Math.max(0, totalTokens - 72), cacheWrite: 0, totalTokens });

/** The records of an omp subagent's transcript that say where its turn stands, as omp 19.1 writes them. */
export const records = {
  prompt: (at: number) => message(at, { role: "user", content: [{ type: "text", text: "Complete assignment thoroughly:\n\ngo" }], attribution: "agent" }),
  calls: (at: number, tokens = 1000) => message(at, { role: "assistant", content: [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "/w/a.ts" } }], stopReason: "toolUse", usage: usage(tokens) }),
  result: (at: number, answer = "contents") => message(at, { role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: answer }] }),
  answered: (at: number, tokens = 2000) => message(at, { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop", usage: usage(tokens) }),
  failed: (at: number) => message(at, { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate_limit_error", usage: usage(0) }),
  interrupted: (at: number) => message(at, { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Interrupted by user" }),
  killed: (at: number) => message(at, { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Previous OMP process exited before completing the turn." }),
  woken: (at: number, customType = "irc:incoming") => record("custom_message", at, { customType, content: "a message for you", display: true, attribution: "agent" }),
  steer: (at: number) => message(at, { role: "developer", content: [{ type: "text", text: "Call yield with your result." }], attribution: "agent" }),
  // what omp writes after an answer that filled the context: the compaction, and the state it re-adds, which start no turn
  compaction: (at: number) => record("compaction", at, { summary: "## Goal\nthe work so far", shortSummary: "Remote compaction", firstKeptEntryId: "r1", tokensBefore: 850_000, tokensAfter: 78_000 }),
  summary: (at: number) => message(at, { role: "custom", customType: "eval-state-context", content: "<system-reminder>Eval runtime state is host-retained.</system-reminder>", display: false, attribution: "agent" }),
  context: (at: number) => record("custom_message", at, { customType: "eval-state-context", content: "<system-reminder>Eval runtime state is host-retained.</system-reminder>", display: false, attribution: "agent" }),
  mark: (at: number) => record("custom", at, { customType: "tool_execution_start", data: { toolCallId: "toolu_1", toolName: "read" } }),
  exit: (at: number, reason = "dispose") => record("custom", at, { customType: "session_exit", data: { reason, kind: reason === "dispose" ? "normal" : "signal", recordedAt: stamp(at) } }),
};

export interface AgentOptions {
  /** the agent type `session_init` names: `task` */
  type?: string;
  /** what `model_change` names, `provider/id` */
  model?: string;
  /** the system prompt `session_init` carries: a short one */
  prompt?: string;
}

export interface OmpSessionFixture {
  root: string;
  /** the session's transcript: its subagents are in the folder beside it */
  path: string;
  dir: string;
  /** a subagent's transcript as a string: the records omp writes first, then `entries` */
  transcript: (startedAt: number, entries: readonly unknown[], options?: AgentOptions) => string;
  /** writes the transcript of a subagent in the session's folder, and returns its path */
  agent: (name: string, startedAt: number, entries: readonly unknown[], options?: AgentOptions) => string;
  append: (name: string, ...entries: unknown[]) => void;
}

export function ompSession(): OmpSessionFixture {
  const root = mkdtempSync(join(tmpdir(), "ovis-omp-subagents-"));
  roots.push(root);
  const path = join(root, "2026-11-23T00-00-00-000Z_01a207c9.jsonl");
  const dir = path.slice(0, -".jsonl".length);
  writeFileSync(path, json({ type: "title", v: 1, title: "", updatedAt: stamp(0), pad: " ".repeat(60) }) + json({ type: "session", version: 3, id: "01a207c9", timestamp: stamp(0), cwd: "/w" }));
  mkdirSync(dir);
  const transcript = (startedAt: number, entries: readonly unknown[], { type = "task", model = "anthropic/claude-sonnet-5-5", prompt = "You are omp's trusted coding assistant." }: AgentOptions = {}): string => [
    { type: "title", v: 1, title: "", updatedAt: stamp(startedAt), pad: " ".repeat(60) },
    { type: "session", version: 3, id: `s${++sequence}`, timestamp: stamp(startedAt), cwd: "/w", parentSession: path },
    record("model_change", startedAt, { model, resolvedModelIsFallback: false }),
    record("session_init", startedAt, { systemPrompt: [prompt], task: "Complete assignment thoroughly:\n\ngo", tools: ["read"], mountedTools: [], agent: type, modelRole: "task", resolvedModel: `${model}:high`, readOnly: false, spawns: "*" }),
    ...entries,
  ].map(json).join("");
  return {
    root, path, dir, transcript,
    agent(name, startedAt, entries, options) {
      const file = join(dir, `${name}.jsonl`);
      writeFileSync(file, transcript(startedAt, entries, options));
      return file;
    },
    append(name, ...entries) {
      appendFileSync(join(dir, `${name}.jsonl`), entries.map(json).join(""));
    },
  };
}
