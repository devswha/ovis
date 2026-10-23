/**
 * Muse Code's session log, read into turns. Each line is an envelope (`payload_type`,
 * `recorded_at` in microseconds, `payload`); a run's own events sit in a `runtime.session`
 * payload as `{ kind: "run", event: { kind } }`. The transcript is in a few of them:
 * - a prompt: `runtime.user_intent.accepted`, once per message sent, a steer mid-run included
 *   (`run/started` repeats the words, but not for a steer);
 * - an answer: `assistant_message_committed`, with `phase: "commentary"` for progress prose;
 * - reasoning: `reasoning_summary_committed` (`reasoning_committed` holds encrypted content only);
 * - tool calls: `assistant_tool_calls_committed`, arguments as a JSON string; their results:
 *   `tool_result_batch_committed`, by `tool_call_id` (`task/output` is the stream of them);
 * - a compaction: `context_compaction_installed` with a `summary_text` replacement.
 * Every other record is bookkeeping. The shapes are the same from Muse 1.4.2 to 1.4.12.
 */
import { closeSync, openSync, readSync } from "node:fs";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { trimOutput } from "./tool-output.ts";
import { toolSummary } from "./transcript-records.ts";

type Row = Record<string, unknown>;
type Tool = Extract<ConversationPart, { kind: "tool" }>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string => typeof value === "string" ? value : "";

/** Lines without one of these hold nothing the reader takes; they are skipped before parsing. */
const MARKS = ['"runtime.user_intent.accepted"', '"assistant_message_committed"', '"reasoning_summary_committed"',
  '"assistant_tool_calls_committed"', '"tool_result_batch_committed"', '"context_compaction_installed"'];

function iso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(Math.floor(value / 1000)).toISOString() : null;
}

/** The words of an accepted intent, or null when the record is none or carries no text. */
export function musePrompt(entry: Row): string | null {
  if (entry.payload_type !== "runtime.user_intent.accepted") return null;
  const texts = list(record(entry.payload).model_messages).flatMap((message) => list(record(message).content))
    .map(record).filter((block) => block.kind === "text" && str(block.text).trim() !== "").map((block) => str(block.text));
  return texts.length > 0 ? texts.join("\n\n") : null;
}

/** A run event: `{ kind: "run", event }` inside a `runtime.session` payload. */
function runEvent(entry: Row): Row | null {
  const payload = record(entry.payload);
  return entry.payload_type === "runtime.session" && payload.kind === "run" ? record(payload.event) : null;
}

/**
 * What a tool's result says, and whether the call failed. Most tools answer with a JSON envelope
 * whose `output` is the text and whose `exit_code` tells how a command ended; any other result is
 * shown as written. A call the harness refused or failed answers `tool denied: …` / `tool failed: …`.
 */
export function museResult(text: string): { text: string; error: boolean } {
  if (text.startsWith("tool denied:") || text.startsWith("tool failed:")) return { text, error: true };
  let parsed: Row;
  try { parsed = record(JSON.parse(text)); } catch { return { text, error: false }; }
  if (typeof parsed.output === "string") return { text: parsed.output, error: typeof parsed.exit_code === "number" && parsed.exit_code !== 0 };
  return { text, error: false };
}

export function parseMuseTranscript(text: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const calls = new Map<string, Tool>();
  const answer = (ts: string | null, parts: ConversationPart[]): void => {
    const last = turns.at(-1);
    if (last?.role === "assistant") { last.parts.push(...parts); if (ts !== null) last.end_ts = ts; }
    else turns.push({ role: "assistant", ts, ...(ts === null ? {} : { end_ts: ts }), parts });
  };
  for (const line of text.split("\n")) {
    if (!MARKS.some((mark) => line.includes(mark))) continue;
    let entry: Row;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    const ts = iso(entry.recorded_at);
    const prompt = musePrompt(entry);
    if (prompt !== null) { turns.push({ role: "user", ts, parts: [{ kind: "text", text: prompt }] }); continue; }
    const event = runEvent(entry);
    if (event === null) continue;
    if (event.kind === "assistant_message_committed" && str(event.text).trim() !== "") {
      answer(ts, [{ kind: "text", text: str(event.text), ...(event.phase === "commentary" ? { phase: "commentary" as const } : {}) }]);
    } else if (event.kind === "reasoning_summary_committed" && str(event.text).trim() !== "") {
      answer(ts, [{ kind: "thinking", text: str(event.text) }]);
    } else if (event.kind === "assistant_tool_calls_committed") {
      const parts: Tool[] = [];
      for (const call of list(event.tool_calls).map(record)) {
        const name = str(call.name) || "tool";
        const input = typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {});
        let args: Row = {};
        try { args = record(JSON.parse(input)); } catch { /* summarized by name */ }
        const part: Tool = { kind: "tool", name, summary: toolSummary(name, args), input, output: "" };
        if (str(call.call_id) !== "") calls.set(str(call.call_id), part);
        parts.push(part);
      }
      if (parts.length > 0) answer(ts, parts);
    } else if (event.kind === "tool_result_batch_committed") {
      for (const item of list(event.results).map(record)) {
        const id = str(item.tool_call_id);
        let part = calls.get(id);
        if (part === undefined) {
          // its call is on an earlier page: the output still shows, on its own row
          part = { kind: "tool", name: "Tool output", summary: "", input: "", output: "" };
          answer(ts, [part]);
        }
        const result = museResult(str(item.text));
        trimOutput(part, result.text, id);
        // a result without an id has no ref to fetch the rest by
        if (id === "") { delete part.output_ref; delete part.output_size; }
        if (result.error) part.error = true;
      }
    } else if (event.kind === "context_compaction_installed") {
      const replacement = record(event.replacement);
      if (replacement.kind === "summary_text" && str(replacement.text).trim() !== "") {
        turns.push({ role: "user", ts, parts: [{ kind: "compact", text: str(replacement.text) }] });
      }
    }
  }
  return turns;
}

/** The model a Muse log names last: its configured model, then each response's own. */
export function museModel(text: string, model: string | null): string | null {
  for (const line of text.split("\n")) {
    if (!line.includes('"run.model.configured"') && !line.includes('"model_completed"')) continue;
    let entry: Row;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    const event = runEvent(entry);
    const named = entry.payload_type === "run.model.configured" ? str(record(record(entry.payload).record).model_id)
      : event?.kind === "model_completed" ? str(event.model) : "";
    if (named !== "") model = named;
  }
  return model;
}

/** The whole result of one call, by its id, unwrapped as the page unwraps it. */
// ponytail: reads the log from the start per request; read backwards from the end if logs grow past a few hundred MB
export function museToolOutput(path: string, ref: string): string | null {
  const id = JSON.stringify(ref);
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let carry = Buffer.alloc(0);
    for (let position = 0, got = 0; (got = readSync(fd, chunk, 0, chunk.length, position)) > 0; position += got) {
      const bytes = Buffer.concat([carry, chunk.subarray(0, got)]);
      const end = bytes.lastIndexOf(0x0a) + 1;
      carry = Buffer.from(bytes.subarray(end));
      for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.includes(id) || !line.includes('"tool_result_batch_committed"')) continue;
        let event: Row | null;
        try { event = runEvent(record(JSON.parse(line))); } catch { continue; }
        const item = list(event?.results).map(record).find((result) => result.tool_call_id === ref);
        if (item !== undefined) return museResult(str(item.text)).text;
      }
    }
    return null;
  } catch { return null; } finally { closeSync(fd); }
}
