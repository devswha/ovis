/**
 * Which Letta Code conversation a pane shows. herdr's Letta integration (`herdr integration install
 * letta`) reports it from Letta's SessionStart hook: `herdr:letta`, the conversation id, or
 * `default:<agent id>` for an agent's default conversation. herdr 0.9.5 keeps the first report of a
 * process, so after `/new` or `/resume` it can still name the conversation the pane left. Letta
 * itself records the conversation each process opens, on start and on every switch, as its project's
 * `.letta/settings.local.json` (`sessionsByServer`; `settings.json` in its config folder when it runs
 * in the home folder). A pane is bound only when both name the same conversation and no other pane
 * reports it; anything else leaves Chat on Terminal.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";

/** Ids herdr's hook reports: Letta's are `conv-<uuid>`, `local-conv-<n>`, `agent-<uuid>` and `agent-local-<uuid>`. */
const ID = /^[A-Za-z0-9._-]{1,200}$/;
/** A settings file is small: one past this is not read. */
const SETTINGS_BYTES = 256 * 1024;

export interface LettaSession {
  reported: string;
  /** null when the report names a conversation without its agent */
  agent: string | null;
  conversation: string;
}

/** The conversation herdr's Letta integration reported for the pane, or null for none or another shape. */
export function lettaSessionOf(pane: Pick<HerdrPane, "agent_session">): LettaSession | null {
  const session = pane.agent_session;
  if (session?.agent !== "letta" || session.source !== "herdr:letta" || session.kind !== "id" || typeof session.value !== "string") return null;
  const reported = session.value;
  if (reported.startsWith("default:")) {
    const agent = reported.slice("default:".length);
    return ID.test(agent) ? { reported, agent, conversation: "default" } : null;
  }
  return ID.test(reported) ? { reported, agent: null, conversation: reported } : null;
}

/** Letta's config folder: `$LETTA_CONFIG_DIR` when absolute, else `~/.letta`. */
export function lettaConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["LETTA_CONFIG_DIR"]?.trim();
  if (override && isAbsolute(override)) return normalize(override);
  return join(env["HOME"] || homedir(), ".letta");
}

/** Where Letta writes transcripts: `$LETTA_TRANSCRIPT_ROOT`, else `transcripts` in its config folder. */
export function lettaTranscriptRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env["LETTA_TRANSCRIPT_ROOT"]?.trim() || join(lettaConfigDir(env), "transcripts");
}

/** A folder name as Letta makes one of an id (`sanitizePathSegment`). */
const segment = (id: string): string => id.replace(/[^a-zA-Z0-9._-]/g, "_").trim() || "unknown";

export const lettaTranscriptPath = (root: string, agent: string, conversation: string): string =>
  join(root, segment(agent), segment(conversation), "transcript.jsonl");

function readSmall(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    if (size > SETTINGS_BYTES) return null;
    const buffer = Buffer.alloc(size);
    return buffer.subarray(0, readSync(fd, buffer, 0, size, 0)).toString("utf8");
  } catch { return null; } finally { closeSync(fd); }
}

/** The conversations a Letta settings file says its processes opened last, one per server; [] for none or an unreadable file. */
export function lettaOpenedSessions(text: string | null): { agent: string; conversation: string }[] {
  if (text === null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const servers = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>)["sessionsByServer"] : undefined;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return [];
  const sessions: { agent: string; conversation: string }[] = [];
  for (const value of Object.values(servers as Record<string, unknown>)) {
    const ref = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    if (typeof ref["agentId"] === "string" && typeof ref["conversationId"] === "string") sessions.push({ agent: ref["agentId"], conversation: ref["conversationId"] });
  }
  return sessions;
}

/** What Letta recorded for a process running in `cwd`: its project's settings, else (in the home folder) its global ones. */
function openedFor(cwd: string, configDir: string): { agent: string; conversation: string }[] {
  const project = lettaOpenedSessions(readSmall(join(cwd, ".letta", "settings.local.json")));
  return project.length > 0 ? project : lettaOpenedSessions(readSmall(join(configDir, "settings.json")));
}

/**
 * The agent and conversation the pane shows, proven by herdr's report and Letta's own record of what
 * the process opened (see the top of this file), or null. `opened`: that record. The agent comes from
 * the record when the report names only a conversation (`local-conv-<n>` repeats across agents), and
 * every record of that agent must name the reported conversation, so a switch the report missed binds nothing.
 */
export function lettaBinding(session: LettaSession, opened: readonly { agent: string; conversation: string }[]): { agent: string; conversation: string } | null {
  const named = opened.filter((ref) => ref.conversation === session.conversation && (session.agent === null || ref.agent === session.agent));
  const agents = new Set(named.map((ref) => ref.agent));
  if (agents.size !== 1) return null;
  const agent = [...agents][0]!;
  if (!ID.test(agent) || opened.some((ref) => ref.agent === agent && ref.conversation !== session.conversation)) return null;
  return { agent, conversation: session.conversation };
}

export type LettaTranscript = { path: string; session: string };

/**
 * The transcript a Letta pane shows, or null when the pane is not bound (lettaBinding) or another pane
 * reports the same conversation. The file may not exist yet: Letta writes it when the first turn ends.
 */
export function resolveLettaTranscript(pane: HerdrPane, panes: readonly HerdrPane[], env: NodeJS.ProcessEnv = process.env): LettaTranscript | null {
  const session = lettaSessionOf(pane);
  if (session === null) return null;
  if (panes.some((other) => other.pane_id !== pane.pane_id && lettaSessionOf(other)?.reported === session.reported)) return null;
  const cwd = typeof pane.foreground_cwd === "string" && pane.foreground_cwd !== "" ? pane.foreground_cwd : pane.cwd;
  if (typeof cwd !== "string" || cwd === "") return null;
  const bound = lettaBinding(session, openedFor(cwd, lettaConfigDir(env)));
  return bound === null ? null : { path: lettaTranscriptPath(lettaTranscriptRoot(env), bound.agent, bound.conversation), session: session.reported };
}
