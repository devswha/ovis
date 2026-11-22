/**
 * Claude Code's command approvals through its own PermissionRequest hook, for a Claude Ovis starts on this PC.
 *
 * Such a Claude gets an HTTP hook (its `--settings`, in a 0600 file: the token is never on a command line) that posts
 * each Bash permission request to a listener here, on loopback only, with a token that names the pane it was started
 * in. The request is held open while the card shows it: the card reads the whole command from it rather than from the
 * screen, and a Yes or No from the card is the hook's answer, not keys. Measured on Claude Code 2.1.330:
 * - the terminal draws its own dialog while the hook waits, and whichever answers first wins;
 * - answered in the terminal, the hook's request stays open and a later answer to it is ignored, so a request the
 *   screen no longer shows is released here (answered with no decision);
 * - a hook that cannot connect, or gets a 401, leaves the terminal's dialog as it is, at once.
 * So every card still has its keys: the hook is only how a Yes or No goes when it holds the very request on screen.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { settingsFile } from "./claude-settings-file.ts";
import { jsonResponse } from "./http.ts";

export type PermissionDecision = "allow" | "deny";

export interface HeldPermission {
  command: string;
  description: string | null;
}

interface Pending extends HeldPermission {
  at: number;
  settle: (decision: PermissionDecision | null) => void;
}

const PATH = "/claude/permission";
const BODY_MAX = 256 * 1024;
/** A read of the screen just before Claude draws its dialog must not release the hook it sent with it. */
const GRACE_MS = 3_000;
/** Claude Code's own default for an HTTP hook: past it Claude has stopped waiting on the request. */
const HELD_MS = 600_000;
const PANES_MAX = 256;
const COMMAND_MAX = 16_000;

/** A narrow pane wraps a command anywhere, and indents what it wraps. */
const squeezed = (text: string): string => text.replace(/\s+/g, "");

/** Whether the dialog's text shows this command: its first 40 characters, wherever the pane wrapped them. */
function shows(body: string, command: string): boolean {
  const start = squeezed(command).slice(0, 40);
  return start.length > 0 && squeezed(body).includes(start);
}

export class ClaudePermissionHooks {
  private listener: ReturnType<typeof Bun.serve> | null = null;
  private readonly panes = new Map<string, string>();
  private readonly pending = new Map<string, Pending[]>();

  constructor(private readonly dir: string, private readonly options: { now?: () => number; heldMs?: number; onHeld?: (paneId: string) => void } = {}) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private listening(): ReturnType<typeof Bun.serve> {
    if (this.listener !== null) return this.listener;
    // a settings file names a token of an earlier run of this server, which nothing here answers any more
    try { for (const name of readdirSync(this.dir)) if (name.endsWith(".json")) rmSync(join(this.dir, name), { force: true }); } catch {}
    // no idle cut (Bun's default is 10 s): a request waits as long as its card does
    this.listener = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (request) => this.receive(request) });
    return this.listener;
  }

  /**
   * `args` for a Claude started in `paneId`, with the hook in a `--settings` file. An inline JSON `--settings` it
   * already has (the dialog's) goes into that file with it; a `--settings` that names a file, or more than one, could
   * not be merged, and leaves `args` as they are.
   */
  launchArgs(paneId: string, args: readonly string[] | undefined): string[] | undefined {
    const given = args ?? [];
    const end = given.indexOf("--");
    const flags = end < 0 ? given : given.slice(0, end);
    const at = flags.flatMap((arg, index) => arg === "--settings" || arg.startsWith("--settings=") ? [index] : []);
    if (at.length > 1) return args === undefined ? undefined : [...given];
    let settings: Record<string, unknown> = {};
    let replaced: { from: number; to: number } | null = null;
    if (at.length === 1) {
      const index = at[0]!;
      const inline = flags[index] === "--settings";
      const value = inline ? flags[index + 1] : flags[index]!.slice("--settings=".length);
      if (value === undefined) return [...given];
      try {
        const parsed: unknown = JSON.parse(value.trim().startsWith("{") ? value : "null");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [...given];
        settings = parsed as Record<string, unknown>;
      } catch {
        return [...given];
      }
      replaced = { from: index, to: index + (inline ? 2 : 1) };
    }
    const token = randomBytes(32).toString("base64url");
    const port = this.listening().port;
    const hooks = typeof settings["hooks"] === "object" && settings["hooks"] !== null && !Array.isArray(settings["hooks"])
      ? { ...(settings["hooks"] as Record<string, unknown>) } : {};
    const theirs = Array.isArray(hooks["PermissionRequest"]) ? hooks["PermissionRequest"] as unknown[] : [];
    // Monitor too: under a Bash-only matcher Claude Code posts a Monitor command as a Bash call, whose allow it then
    // ignores (its hooks reference, 2.1.314 on); matched by name it comes as itself, and is left to the terminal here
    hooks["PermissionRequest"] = [...theirs, {
      matcher: "Bash|Monitor",
      hooks: [{ type: "http", url: `http://127.0.0.1:${port}${PATH}`, headers: { Authorization: `Bearer ${token}` } }],
    }];
    let path: string;
    try {
      path = settingsFile(JSON.stringify({ ...settings, hooks }), this.dir);
    } catch (error) {
      console.error(`claude permission hook: ${error instanceof Error ? error.message : String(error)}`);
      return args === undefined ? undefined : [...given];
    }
    this.panes.set(digest(token), paneId);
    if (this.panes.size > PANES_MAX) this.panes.delete(this.panes.keys().next().value!);
    if (replaced === null) return ["--settings", path, ...given];
    return [...given.slice(0, replaced.from), "--settings", path, ...given.slice(replaced.to)];
  }

  private paneOf(authorization: string | null): string | undefined {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    if (token === "") return undefined;
    const key = digest(token);
    for (const [known, pane] of this.panes) {
      if (timingSafeEqual(Buffer.from(known, "hex"), Buffer.from(key, "hex"))) return pane;
    }
    return undefined;
  }

  private async receive(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== PATH) return new Response(null, { status: 404 });
    const paneId = this.paneOf(request.headers.get("authorization"));
    if (paneId === undefined) return new Response(null, { status: 401 });
    if (Number(request.headers.get("content-length") ?? 0) > BODY_MAX) return new Response(null, { status: 413 });
    const text = await request.text();
    if (text.length > BODY_MAX) return new Response(null, { status: 413 });
    let input: { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown };
    try { input = JSON.parse(text) as typeof input; } catch { return new Response(null, { status: 400 }); }
    const tool = input.tool_input as { command?: unknown; description?: unknown } | null | undefined;
    // a Monitor command, or anything not a Bash command, is the terminal's: no decision
    if (input.hook_event_name !== "PermissionRequest" || input.tool_name !== "Bash" || typeof tool !== "object" || tool === null
      || typeof tool.command !== "string" || tool.command.trim() === "") return jsonResponse({});
    const command = tool.command.slice(0, COMMAND_MAX);
    const description = typeof tool.description === "string" && tool.description.trim() !== "" ? tool.description.slice(0, COMMAND_MAX) : null;
    const decision = await new Promise<PermissionDecision | null>((resolve) => {
      const list = this.pending.get(paneId) ?? [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: Pending = {
        command, description, at: this.now(),
        settle: (decision) => {
          clearTimeout(timer);
          const left = (this.pending.get(paneId) ?? []).filter((other) => other !== entry);
          if (left.length) this.pending.set(paneId, left);
          else this.pending.delete(paneId);
          resolve(decision);
        },
      };
      list.push(entry);
      this.pending.set(paneId, list);
      timer = setTimeout(() => entry.settle(null), this.options.heldMs ?? HELD_MS);
      request.signal.addEventListener("abort", () => entry.settle(null), { once: true });
      this.options.onHeld?.(paneId);
    });
    if (decision === null) return jsonResponse({});
    return jsonResponse({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        // No, as the terminal's No: Claude stops and waits for the user
        decision: decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "The user declined this command in Ovis.", interrupt: true },
      },
    });
  }

  /** The one held request a Claude approval card with this text shows, or null when none or more than one does. */
  private matching(paneId: string, body: string): Pending | null {
    const found = (this.pending.get(paneId) ?? []).filter((entry) => shows(body, entry.command));
    return found.length === 1 ? found[0]! : null;
  }

  /**
   * What a read of `paneId` found: the text of the Claude approval on its screen, or null for none. A held request
   * the screen does not show (answered in the terminal, or by another dialog) is released; the one it shows is
   * returned, for its card to show whole.
   */
  shown(paneId: string, approval: string | null): HeldPermission | null {
    const held = approval === null ? null : this.matching(paneId, approval);
    for (const entry of this.pending.get(paneId) ?? []) {
      if (entry !== held && this.now() - entry.at >= GRACE_MS) entry.settle(null);
    }
    return held === null ? null : { command: held.command, description: held.description };
  }

  /**
   * Answers the request the Claude approval card with this text shows, for the option labelled `label`: Yes allows,
   * No declines. False when no one request is held for it, or for any other option (its keys answer it).
   */
  answer(paneId: string, approval: string, label: string): boolean {
    const decision: PermissionDecision | null = label === "Yes" ? "allow" : /^No\b/.test(label) ? "deny" : null;
    if (decision === null) return false;
    const held = this.matching(paneId, approval);
    if (held === null) return false;
    held.settle(decision);
    return true;
  }

  stop(): void {
    // each held request gets its answer (no decision, so the terminal's dialog stands) before the listener closes
    for (const list of [...this.pending.values()]) for (const entry of list) entry.settle(null);
    void this.listener?.stop();
    this.listener = null;
  }
}

const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

/** In the order Claude's dialog draws them. */
export function heldBody(held: HeldPermission): string {
  return held.description === null ? held.command : `${held.description}\n${held.command}`;
}
