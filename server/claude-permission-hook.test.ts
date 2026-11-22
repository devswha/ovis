import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudePermissionHooks, heldBody } from "./claude-permission-hook.ts";

const ULTRACODE = JSON.stringify({ ultracode: true });
type HookSettings = { ultracode?: boolean; hooks: { PermissionRequest: { matcher: string; hooks: { type: string; url: string; headers: { Authorization: string } }[] }[] } };

const roots: string[] = [];
const started: ClaudePermissionHooks[] = [];
afterEach(() => {
  for (const hooks of started.splice(0)) hooks.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hooksIn(options: { now?: () => number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-permission-hook-")));
  roots.push(root);
  const waiting = new Map<string, () => void>();
  const hooks = new ClaudePermissionHooks(join(root, "hooks"), { ...options, onHeld: (paneId) => waiting.get(paneId)?.() });
  started.push(hooks);
  const held = (paneId: string) => new Promise<void>((resolve) => waiting.set(paneId, resolve));
  return { hooks, held };
}

const settingsOf = (args: string[]): { path: string; settings: HookSettings } => {
  const path = args[args.indexOf("--settings") + 1]!;
  return { path, settings: JSON.parse(readFileSync(path, "utf8")) as HookSettings };
};

// a fresh connection each time, as each listener here is new: a pooled one could name a port an earlier test closed
const post = (url: string, authorization: string, body: unknown, signal?: AbortSignal) =>
  fetch(url, { method: "POST", keepalive: false, headers: { "content-type": "application/json", authorization }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
const ask = (args: string[], body: unknown, signal?: AbortSignal) => {
  const hook = settingsOf(args).settings.hooks.PermissionRequest.at(-1)!.hooks[0]!;
  return post(hook.url, hook.headers.Authorization, body, signal);
};
const bash = (command: string, description?: string) => ({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command, ...(description ? { description } : {}) } });
const CARD = "Create empty marker-a.txt file\ntouch marker-a.txt";

describe("launchArgs", () => {
  it("puts the hook in a private settings file, merged with the dialog's inline settings", () => {
    const { hooks } = hooksIn();
    const plain = hooks.launchArgs("p1", undefined)!;
    expect(plain.slice(0, 1)).toEqual(["--settings"]);
    const { path, settings } = settingsOf(plain);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const hook = settingsOf(plain).settings.hooks.PermissionRequest[0]!;
    expect(hook.matcher).toBe("Bash|Monitor");
    expect(hook.hooks[0]).toMatchObject({ type: "http", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/claude\/permission$/) });
    expect(plain.join(" ")).not.toContain(hook.hooks[0]!.headers.Authorization.slice("Bearer ".length));
    expect(settings.ultracode).toBeUndefined();

    const merged = hooks.launchArgs("p1", ["--model", "opus", "--settings", ULTRACODE, "--", "--settings"])!;
    expect(merged.slice(0, 2)).toEqual(["--model", "opus"]);
    expect(merged.slice(2, 3)).toEqual(["--settings"]);
    expect(merged.slice(4)).toEqual(["--", "--settings"]);
    expect(settingsOf(merged).settings.ultracode).toBe(true);
  });

  it("keeps the hooks the dialog's settings already had", () => {
    const { hooks } = hooksIn();
    const theirs = { matcher: "Edit", hooks: [{ type: "command", command: "true" }] };
    const args = hooks.launchArgs("p1", [`--settings=${JSON.stringify({ hooks: { PermissionRequest: [theirs] } })}`])!;
    expect(settingsOf(args).settings.hooks.PermissionRequest.map((entry) => entry.matcher)).toEqual(["Edit", "Bash|Monitor"]);
  });

  it("leaves settings it cannot merge as they are", () => {
    const { hooks } = hooksIn();
    expect(hooks.launchArgs("p1", ["--settings", "/home/user/s.json"])).toEqual(["--settings", "/home/user/s.json"]);
    expect(hooks.launchArgs("p1", ["--settings", ULTRACODE, `--settings=${ULTRACODE}`])).toEqual(["--settings", ULTRACODE, `--settings=${ULTRACODE}`]);
  });
});

describe("the hook listener", () => {
  it("refuses a request without the launch's token", async () => {
    const { hooks } = hooksIn();
    const args = hooks.launchArgs("p1", undefined)!;
    const { url } = settingsOf(args).settings.hooks.PermissionRequest[0]!.hooks[0]!;
    const response = await post(url, "Bearer guessed", bash("ls"));
    expect(response.status).toBe(401);
  });

  it("answers Yes on the card that shows the held command as the hook's allow", async () => {
    const { hooks, held } = hooksIn();
    const args = hooks.launchArgs("p1", undefined)!;
    const holding = held("p1");
    const answer = ask(args, bash("touch marker-a.txt", "Create empty marker-a.txt file"));
    await holding;
    expect(hooks.shown("p1", CARD)).toEqual({ command: "touch marker-a.txt", description: "Create empty marker-a.txt file" });
    expect(hooks.answer("p2", CARD, "Yes")).toBe(false);
    expect(hooks.answer("p1", CARD, "Yes, and always allow access to /repo from this project")).toBe(false);
    expect(hooks.answer("p1", CARD, "Yes")).toBe(true);
    expect(await (await answer).json()).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(hooks.answer("p1", CARD, "Yes")).toBe(false);
  });

  it("answers No as a decline that stops Claude, as the terminal's No does", async () => {
    const { hooks, held } = hooksIn();
    const args = hooks.launchArgs("p1", undefined)!;
    const holding = held("p1");
    const answer = ask(args, bash("rm -rf build"));
    await holding;
    expect(hooks.answer("p1", "Bash command\nrm -rf build", "No")).toBe(true);
    expect(await (await answer).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny", interrupt: true } } });
  });

  it("finds a command the pane wrapped", async () => {
    const { hooks, held } = hooksIn();
    const args = hooks.launchArgs("p1", undefined)!;
    const command = "git log --oneline --graph --decorate --all -- server/claude-permission-hook.ts";
    const holding = held("p1");
    const answer = ask(args, bash(command));
    await holding;
    expect(hooks.shown("p1", "git log --oneline --graph\n  --decorate --all -- server/claude-\n  permission-hook.ts")?.command).toBe(command);
    hooks.stop();
    expect(await (await answer).json()).toEqual({});
  });

  it("releases a request the screen no longer shows, once Claude has had time to draw it", async () => {
    let now = 1_000;
    const { hooks, held } = hooksIn({ now: () => now });
    const args = hooks.launchArgs("p1", undefined)!;
    const holding = held("p1");
    const answer = ask(args, bash("touch marker-b.txt"));
    await holding;
    // read just before the dialog is drawn
    expect(hooks.shown("p1", null)).toBeNull();
    expect(hooks.shown("p1", "touch marker-b.txt")).not.toBeNull();
    now += 3_000;
    // answered in the terminal: the next read finds no dialog
    expect(hooks.shown("p1", null)).toBeNull();
    expect(await (await answer).json()).toEqual({});
    expect(hooks.answer("p1", "touch marker-b.txt", "Yes")).toBe(false);
  });

  it("leaves a Monitor command to the terminal at once", async () => {
    const { hooks } = hooksIn();
    const args = hooks.launchArgs("p1", undefined)!;
    const response = await ask(args, { hook_event_name: "PermissionRequest", tool_name: "Monitor", tool_input: { command: "tail -f log" } });
    expect(await response.json()).toEqual({});
  });

  it("forgets a request whose hook gave up", async () => {
    const { hooks, held } = hooksIn();
    const args = hooks.launchArgs("p1", undefined)!;
    const holding = held("p1");
    const gone = new AbortController();
    const answer = ask(args, bash("touch marker-c.txt"), gone.signal);
    answer.catch(() => undefined);
    await holding;
    gone.abort();
    await answer.catch(() => undefined);
    expect(hooks.answer("p1", "touch marker-c.txt", "Yes")).toBe(false);
  });
});

it("shows the whole command under Claude's words for it", () => {
  expect(heldBody({ command: "touch a", description: "Create a" })).toBe("Create a\ntouch a");
  expect(heldBody({ command: "touch a", description: null })).toBe("touch a");
});
