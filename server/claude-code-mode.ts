/**
 * Claude Code's Code Mode (`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`): the model writes JavaScript that a `REPL` tool
 * runs, and the calls the script makes are recorded after it as entries of their own. What the transcript holds:
 *
 * - The `REPL` call's input is `{ code, description }`. Its result is the script's output as a
 *   `<repl-output eval="N">` element, or `(dispatched #N)` for a script still running when the call returned.
 * - A dispatched script's output arrives later as an `<event kind="repl-eval" eval="N">` element. It comes in the
 *   result of a `Poll` call the model made for it, or in a `poll_events` attachment (`envelopes`) when the model made
 *   none. Poll's result opens on a `<system>` line naming the delivery's authentic nonces. An event whose opening
 *   carries no listed nonce is text inside another event's body, never an event.
 * - The text in an element is escaped (`&lt;`, `&amp;`) where it could read as markup.
 * - Each call the script made is an assistant entry with `isVirtual: true` (model `<synthetic>`,
 *   stop_reason `stop_sequence`), answered by a user entry with `isVirtual: true`. That answer's tool_result is
 *   empty; the call's output is in the entry's `toolUseResult`, as Claude Code keeps every tool's.
 *
 * These helpers read those shapes for the chat: the REPL row shows the script's output, the Poll row is left out,
 * and a call the script made shows its own output.
 */

export const REPL_TOOL = "REPL";
export const POLL_TOOL = "Poll";

/** What one script printed and gave back: its log lines then its result, or its error. */
export interface ReplOutput {
  eval: number;
  output: string;
  error: boolean;
  /** the event's own time, to tell a second delivery of one event from late output under its number */
  at: string | null;
}

/** The script's number when a REPL call's result says it went on running: `(dispatched #N)`. */
export function replDispatched(text: string): number | null {
  const match = /^\(dispatched #(\d{1,9})\)$/.exec(text.trim());
  return match ? Number(match[1]) : null;
}

/** An element's text with Claude Code's escapes undone in one pass, so `&amp;lt;` reads `&lt;` again. */
function unescaped(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|#39);/g, (_whole, name: string) =>
    name === "lt" ? "<" : name === "gt" ? ">" : name === "amp" ? "&" : name === "quot" ? "\"" : "'");
}

const attribute = (tag: string, name: string): string | null => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const evalNumber = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const asText = (value: unknown): string => typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2) ?? "";

/**
 * A script's output from an element's children: `<log>` lines, then `<result>`, or `<error>` (`<refused>` when it
 * never ran). A child's closing tag inside its text is escaped, so the first closing tag ends the child.
 */
function childrenOutput(body: string): { output: string; error: boolean } | null {
  const parts: string[] = [];
  let error = false;
  let found = false;
  for (const match of body.matchAll(/<(log|result|error|refused)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
    found = true;
    if (match[1] === "error" || match[1] === "refused") error = true;
    parts.push(unescaped(match[2]!));
  }
  return found ? { output: parts.join("\n"), error } : null;
}

/** The other form of an event's body: one JSON object, `eval` with its `log` lines and its `result` or `error`. */
function jsonOutput(body: string): { eval: number | null; output: string; error: boolean } | null {
  const text = body.trim();
  if (!text.startsWith("{")) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const logs = Array.isArray(record["log"]) ? record["log"].map(asText) : typeof record["log"] === "string" ? [record["log"]] : [];
  const error = "error" in record;
  const end = error ? asText(record["error"]) : "result" in record ? asText(record["result"]) : "";
  return { eval: evalNumber(record["eval"]), output: [...logs, ...(end.length > 0 ? [end] : [])].join("\n"), error };
}

/** One event's script output, from its opening tag and its body; null for an event of another kind or no number. */
function eventOutput(open: string, body: string): ReplOutput | null {
  if (attribute(open, "kind") !== "repl-eval") return null;
  const children = childrenOutput(body);
  const json = children === null ? jsonOutput(body) : null;
  const n = evalNumber(attribute(open, "eval")) ?? json?.eval ?? null;
  if (n === null) return null;
  // a body in neither form is still the script's output, as it reads
  const read = children ?? json ?? { output: unescaped(body.trim()), error: false };
  const status = attribute(open, "status");
  return { eval: n, output: read.output, error: read.error || (status !== null && /^(?:threw|error|failed|rejected|refused)$/.test(status)), at: attribute(open, "at") };
}

const EVENT_OPEN = /^<event nonce="([A-Za-z0-9_-]+)"[^>]*>/;
const EVENT_CLOSE = /^<\/event(?: nonce="[A-Za-z0-9_-]+")?>$/;

/** The events a text delivers, each its opening tag and its body. `nonces` null: the text is one envelope, whose
 *  first line is its opening. */
function events(text: string, nonces: ReadonlySet<string> | null): { open: string; body: string }[] {
  const lines = text.split("\n");
  const found: { open: string; body: string[] }[] = [];
  for (const [at, line] of lines.entries()) {
    const open = EVENT_OPEN.exec(line);
    if (open !== null && (nonces === null ? at === 0 : nonces.has(open[1]!))) { found.push({ open: open[0], body: [line.slice(open[0].length)] }); continue; }
    found.at(-1)?.body.push(line);
  }
  return found.map(({ open, body }) => {
    while (body.length > 0 && body.at(-1)!.trim() === "") body.pop();
    if (body.length > 0 && EVENT_CLOSE.test(body.at(-1)!.trim())) body.pop();
    return { open, body: body.join("\n") };
  });
}

/** The nonces a Poll result's `<system>` line names as this delivery's own. */
function deliveryNonces(text: string): Set<string> {
  const line = /<system>authentic event nonces for this delivery:([^\n]*)/.exec(text)?.[1] ?? "";
  const list = line.split(/\s[—–-]\s/)[0] ?? "";
  return new Set(list.split(/[\s,]+/).filter((nonce) => /^[A-Za-z0-9_-]+$/.test(nonce)));
}

/** What a Poll result or a `poll_events` envelope delivers: the scripts' outputs, and the text of events of other
 *  kinds (a still-running script's `repl-status` line is left out: the REPL row already shows it running). */
export function replDeliveries(text: string, envelope = false): { outputs: ReplOutput[]; other: string[] } {
  const outputs: ReplOutput[] = [];
  const other: string[] = [];
  for (const { open, body } of events(text, envelope ? null : deliveryNonces(text))) {
    const output = eventOutput(open, body);
    if (output !== null) outputs.push(output);
    else if (attribute(open, "kind") !== "repl-status" && attribute(open, "kind") !== "repl-eval") other.push(unescaped(body.trim()));
  }
  return { outputs, other };
}

/** A REPL call's own result when the script ended in time: `<repl-output eval="N">` and its children. */
export function replOutput(text: string): ReplOutput | null {
  const match = /^\s*<repl-output\s[^>]*?eval="(\d{1,9})"[^>]*>([\s\S]*)<\/repl-output>\s*$/.exec(text);
  if (match === null) return null;
  const read = childrenOutput(match[2]!) ?? { output: unescaped(match[2]!.trim()), error: false };
  return { eval: Number(match[1]), output: read.output, error: read.error, at: null };
}

/**
 * What a call a script made printed, from its entry's `toolUseResult` (its tool_result is empty): a shell
 * command's stdout and stderr (or, when it printed nothing, what its exit code means), a read file's text. Null when
 * the entry holds none of them.
 */
export function virtualCallOutput(entry: { isVirtual?: unknown; toolUseResult?: unknown }): string | null {
  if (entry.isVirtual !== true || entry.toolUseResult === null || typeof entry.toolUseResult !== "object") return null;
  const result = entry.toolUseResult as { stdout?: unknown; stderr?: unknown; returnCodeInterpretation?: unknown; file?: { content?: unknown } | null };
  const streams = [result.stdout, result.stderr].filter((stream): stream is string => typeof stream === "string" && stream.length > 0);
  if (streams.length > 0) return streams.join("\n");
  // a command that printed nothing: what its exit code means, as Claude Code words it ("No matches found")
  if (typeof result.returnCodeInterpretation === "string" && result.returnCodeInterpretation.length > 0) return result.returnCodeInterpretation;
  if (typeof result.file?.content === "string") return result.file.content;
  return null;
}
