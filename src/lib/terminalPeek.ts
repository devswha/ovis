import type { CommandOutcome, ConversationTurn } from "../../shared/protocol.ts";
import type { PaneView } from "./actions.ts";
import type { InputRowState } from "./inputRow.ts";
import type { SplitSlot } from "./split.ts";

export interface PeekRequest {
  command: string;
  text: string | null;
  knownOutcomeIds: readonly string[] | null;
  auto: boolean;
  watch: string | null;
  inputRowSeen: boolean;
}

export interface TerminalPeek extends PeekRequest {
  slot: SplitSlot;
  machineId: string;
  paneId: string;
}

/**
 * The Claude Code commands whose screen, closed and only then, makes Claude record a
 * `local_command` answer the chat reads as a local-command notice (recorded with Claude Code
 * 2.1.306, each sent bare): "Settings dialog dismissed" for /usage, /cost and /status, "<X> dialog
 * dismissed" for /stats, /help, /config, /permissions, /hooks, /skills, /workflows and /passes,
 * "Theme picker dismissed", "Resume cancelled", "Power-ups closed" and "Fast mode ON/OFF".
 *
 * An allow list, so every other command (a custom or unknown one included) comes back by hand:
 * /diff records when its panel opens, which would end the peek at once; /export, /plugin, /mobile,
 * /autocompact, /add-dir, /mcp and /scroll-speed record entries the chat does not show; /sandbox
 * and /tasks record nothing; /memory hands a picked file to the editor. Claude's fullscreen renderer
 * records nothing for most of these, and a session records nothing before its first message: the
 * peek never waits on the record, it only comes back sooner when there is one.
 */
export const CLAUDE_AUTO_RETURN: ReadonlySet<string> = new Set([
  "usage", "cost", "status", "stats", "help", "config", "theme", "permissions", "hooks", "skills", "workflows", "passes",
  "resume", "powerup", "fast",
]);

export function peekFor(peek: TerminalPeek | null, slot: SplitSlot, machineId: string, paneId: string | null): TerminalPeek | null {
  return peek !== null && peek.slot === slot && peek.machineId === machineId && peek.paneId === paneId ? peek : null;
}

export function paneLensFlags(view: PaneView, peek: TerminalPeek | null): { chatMounted: boolean; gridCovered: boolean } {
  const chatMounted = view === "chat";
  return { chatMounted, gridCovered: chatMounted && peek === null };
}

export function autoReturnArmed(agent: string | null, text: string, command: string): boolean {
  return agent === "claude" && /^\S+$/u.test(text.trim()) && CLAUDE_AUTO_RETURN.has(command.toLocaleLowerCase());
}

export interface ScreenReturn {
  bare: ReadonlySet<string>;
  withArguments: ReadonlySet<string>;
  arm: ReadonlySet<InputRowState>;
}

const GONE: ReadonlySet<InputRowState> = new Set(["gone"]);
const GONE_OR_COVERED: ReadonlySet<InputRowState> = new Set(["gone", "covered"]);
const NONE: ReadonlySet<string> = new Set();

/**
 * The agents whose chat comes back by itself, from their screens, and after which commands: those
 * whose recording (2026-10-22, each at 119 or 120 and at 40 columns, opened, then closed with Escape
 * or `q`) hid the input row while open and drew it back empty when closed. An allow list, so a
 * command that prints and keeps the row (Codex /status, omp /plan, pi /hotkeys, gjc /hotkeys, Devin
 * /mcp…), one that hands off to $EDITOR (Hermes /prompt, agy /open), one whose close leaves text in
 * the row (Hermes /palette, Grok /model, Codex /mention), Codex's /side and /btw (their side thread
 * draws a composer of its own) and every unrecorded command come back by hand.
 * - Codex 0.163.0: `/cd` with a folder it does not trust shows the trust screen; a trusted one only
 *   prints, keeps the row and never arms. /diff is a pager that `q` closes.
 * - Hermes' classic CLI draws its row again, empty, for a moment after every slash command, before the
 *   screen opens: only a covered row (a picker over it, a confirmation in its place) arms it.
 * - agy's and Grok's panels and omp's /context at 119 columns leave the row drawn under the screen:
 *   a covered row arms these too.
 * - omp's bare /switch and gjc's bare /model were recorded too, but Chat answers them with its own
 *   model card (server/skills): they never reach the terminal, so they are not listed.
 * OpenCode is not here: only its home screen was recorded, not the in-session layout its screens
 * open over.
 */
export const SCREEN_AUTO_RETURN: Readonly<Record<string, ScreenReturn>> = {
  codex: {
    bare: new Set(["permissions", "theme", "statusline", "resume", "review", "rename", "new", "fork", "usage", "diff"]),
    withArguments: new Set(["cd"]),
    arm: GONE,
  },
  omp: {
    bare: new Set(["settings", "hotkeys", "tree", "resume", "extensions", "agents", "usage", "context", "btw"]),
    withArguments: NONE,
    arm: GONE_OR_COVERED,
  },
  pi: { bare: new Set(["settings", "tree", "resume", "scoped-models"]), withArguments: NONE, arm: GONE },
  gjc: {
    bare: new Set(["settings", "theme", "tree", "resume", "sessions", "transcript", "routing"]),
    withArguments: NONE,
    arm: GONE,
  },
  omo: {
    bare: new Set(["settings", "tree", "thinking", "scoped-models", "favorite-models", "sessions", "resume", "rename", "share", "trust"]),
    withArguments: NONE,
    arm: GONE,
  },
  hermes: { bare: new Set(["model", "reload-mcp", "new", "reset", "clear"]), withArguments: NONE, arm: new Set(["covered"]) },
  devin: {
    bare: new Set(["model", "models", "config", "resume", "theme", "shortcuts", "mode", "btw"]),
    withArguments: NONE,
    arm: GONE,
  },
  agy: {
    bare: new Set(["model", "resume", "config", "permissions", "mcp", "skills", "usage", "context", "help", "tasks", "rewind", "artifact",
      "codesearch", "diff", "changelog"]),
    withArguments: NONE,
    arm: GONE_OR_COVERED,
  },
  grok: {
    bare: new Set(["settings", "sessions", "resume", "plugins", "skills", "hooks", "help", "usage", "context", "history"]),
    withArguments: NONE,
    arm: GONE_OR_COVERED,
  },
};

export function screenReturnArmed(agent: string | null, text: string, command: string): boolean {
  const known = agent === null ? undefined : SCREEN_AUTO_RETURN[agent];
  if (known === undefined || !Object.hasOwn(SCREEN_AUTO_RETURN, agent!)) return false;
  const name = command.toLocaleLowerCase();
  return /^\S+$/u.test(text.trim()) ? known.bare.has(name) : known.withArguments.has(name);
}

export type WatchStep = { step: "wait"; armed: boolean } | { step: "return" } | { step: "manual" };

export function watchReturn(agent: string, armed: boolean, state: InputRowState): WatchStep {
  const known = Object.hasOwn(SCREEN_AUTO_RETURN, agent) ? SCREEN_AUTO_RETURN[agent] : undefined;
  if (known === undefined) return { step: "manual" };
  if (state === "unknown") return { step: "wait", armed };
  if (!armed) return { step: "wait", armed: known.arm.has(state) };
  if (state === "ready") return { step: "return" };
  if (state === "draft") return { step: "manual" };
  return { step: "wait", armed: true };
}

export function sentOutcome(peek: PeekRequest, outcomes: readonly CommandOutcome[]): CommandOutcome | null {
  if (peek.text === null || peek.knownOutcomeIds === null) return null;
  const known = new Set(peek.knownOutcomeIds);
  const text = peek.text.trim();
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    const outcome = outcomes[index]!;
    if (!known.has(outcome.id) && outcome.text.trim() === text) return outcome;
  }
  return null;
}

export function commandScreenClosed(peek: PeekRequest, agent: string | null, sentAt: string | null, turns: readonly ConversationTurn[]): boolean {
  if (!peek.auto || agent !== "claude" || sentAt === null) return false;
  const sent = Date.parse(sentAt);
  if (!Number.isFinite(sent)) return false;
  return turns.some((turn) => turn.role === "user" && turn.ts !== null && Date.parse(turn.ts) > sent
    && turn.parts.some((part) => part.kind === "notice" && part.source === "local-command"));
}

export interface ReturnBlockers {
  heldDraft: boolean;
  findOpen: boolean;
  composing: boolean;
}

export function returnBlocked(blockers: ReturnBlockers): boolean {
  return blockers.heldDraft || blockers.findOpen || blockers.composing;
}
