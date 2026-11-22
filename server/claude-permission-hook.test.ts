import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudePermissionHooks, heldBody } from "./claude-permission-hook.ts";

const ULTRACODE = JSON.stringify({ ultracode: true });
type CommandHook = { type: string; command: string; args: string[] };
type HookSettings = { ultracode?: boolean; hooks: { PermissionRequest: { matcher: string; hooks: CommandHook[] }[] } };

const roots: string[] = [];
const started: ClaudePermissionHooks[] = [];
afterEach(() => {
  for (const hooks of started.splice(0)) hooks.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hooksIn(options: { now?: () => number; platform?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-permission-hook-")));
  roots.push(root);
  const waiting = new Map<string, () => void>();
  const settling = new Map<string, () => void>();
  const dir = join(root, "hooks");
  const hooks = new ClaudePermissionHooks(dir, { ...options, onHeld: (paneId) => waiting.get(paneId)?.(), onSettled: (paneId) => settling.get(paneId)?.() });
  started.push(hooks);
  const held = (paneId: string) => new Promise<void>((resolve) => waiting.set(paneId, resolve));
  const settled = (paneId: string) => new Promise<void>((resolve) => settling.set(paneId, resolve));
  return { hooks, held, settled, dir };
}

const settingsOf = (args: string[]): { path: string; settings: HookSettings } => {
  const path = args[args.indexOf("--settings") + 1]!;
  return { path, settings: JSON.parse(readFileSync(path, "utf8")) as HookSettings };
};
const ourHook = (args: string[]): CommandHook => settingsOf(args).settings.hooks.PermissionRequest.at(-1)!.hooks[0]!;

function ask(hook: CommandHook, body: unknown) {
  const relay = Bun.spawn([hook.command, ...hook.args], { stdin: new Blob([JSON.stringify(body)]), stdout: "pipe", stderr: "pipe", env: process.env });
  const answer = async () => {
    const out = await new Response(relay.stdout).text();
    expect(await relay.exited).toBe(0);
    return out === "" ? null : JSON.parse(out) as unknown;
  };
  return { relay, answer };
}
const bash = (command: string, description?: string) => ({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command, ...(description ? { description } : {}) } });
const CARD = "Create empty marker-a.txt file\ntouch marker-a.txt";

describe("launchArgs", () => {
  it("puts a relay hook in a private settings file, merged with the dialog's inline settings", () => {
    const { hooks, dir } = hooksIn();
    const plain = hooks.launchArgs("p1", undefined)!;
    expect(plain.slice(0, 1)).toEqual(["--settings"]);
    const { path, settings } = settingsOf(plain);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "hub.sock")).mode & 0o777).toBe(0o600);
    const entry = settings.hooks.PermissionRequest[0]!;
    expect(entry.matcher).toBe("Bash|Monitor");
    expect(entry.hooks[0]).toMatchObject({ type: "command", command: process.execPath });
    expect(entry.hooks[0]!.args).toContain(join(dir, "hub.sock"));
    expect(plain.join(" ")).not.toContain(entry.hooks[0]!.args.at(-1)!);
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

  it("adds no hook on Windows, which keeps the keys", () => {
    const { hooks } = hooksIn({ platform: "win32" });
    expect(hooks.launchArgs("p1", undefined)).toBeUndefined();
    expect(hooks.launchArgs("p1", ["--model", "opus"])).toEqual(["--model", "opus"]);
  });
});

describe("the hook relay", () => {
  it("gives no decision for a launch the server does not know", async () => {
    const { hooks } = hooksIn();
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    const guessed = { ...hook, args: [...hook.args.slice(0, -1), "guessed"] };
    expect(await ask(guessed, bash("ls")).answer()).toBeNull();
  });

  it("gives no decision once the server is gone", async () => {
    const { hooks } = hooksIn();
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    hooks.stop();
    expect(await ask(hook, bash("ls")).answer()).toBeNull();
  });

  it("answers Yes on the card that shows the held command as the hook's allow", async () => {
    const { hooks, held } = hooksIn();
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    const holding = held("p1");
    const { answer } = ask(hook, bash("touch marker-a.txt", "Create empty marker-a.txt file"));
    await holding;
    expect(hooks.shown("p1", CARD)).toEqual({ command: "touch marker-a.txt", description: "Create empty marker-a.txt file" });
    expect(hooks.answer("p2", CARD, "Yes")).toBe(false);
    expect(hooks.answer("p1", CARD, "Yes, and always allow access to /repo from this project")).toBe(false);
    expect(hooks.answer("p1", CARD, "Yes")).toBe(true);
    expect(await answer()).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(hooks.answer("p1", CARD, "Yes")).toBe(false);
  });

  it("answers No as a decline that stops Claude, as the terminal's No does", async () => {
    const { hooks, held } = hooksIn();
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    const holding = held("p1");
    const { answer } = ask(hook, bash("rm -rf build"));
    await holding;
    expect(hooks.answer("p1", "Bash command\nrm -rf build", "No")).toBe(true);
    expect(await answer()).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny", interrupt: true } } });
  });

  it("finds a command the pane wrapped", async () => {
    const { hooks, held } = hooksIn();
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    const command = "git log --oneline --graph --decorate --all -- server/claude-permission-hook.ts";
    const holding = held("p1");
    const { answer } = ask(hook, bash(command));
    await holding;
    expect(hooks.shown("p1", "git log --oneline --graph\n  --decorate --all -- server/claude-\n  permission-hook.ts")?.command).toBe(command);
    hooks.stop();
    expect(await answer()).toEqual({});
  });

  it("releases a request the screen no longer shows, once Claude has had time to draw it", async () => {
    let now = 1_000;
    const { hooks, held } = hooksIn({ now: () => now });
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    const holding = held("p1");
    const { answer } = ask(hook, bash("touch marker-b.txt"));
    await holding;
    // read just before the dialog is drawn
    expect(hooks.shown("p1", null)).toBeNull();
    expect(hooks.shown("p1", "touch marker-b.txt")).not.toBeNull();
    now += 3_000;
    // answered in the terminal: the next read finds no dialog
    expect(hooks.shown("p1", null)).toBeNull();
    expect(await answer()).toEqual({});
    expect(hooks.answer("p1", "touch marker-b.txt", "Yes")).toBe(false);
  });

  it("leaves a Monitor command to the terminal at once", async () => {
    const { hooks } = hooksIn();
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    expect(await ask(hook, { hook_event_name: "PermissionRequest", tool_name: "Monitor", tool_input: { command: "tail -f log" } }).answer()).toEqual({});
  });

  it("forgets a request whose hook Claude ended", async () => {
    const { hooks, held, settled } = hooksIn();
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    const holding = held("p1");
    const { relay } = ask(hook, bash("touch marker-c.txt"));
    await holding;
    const released = settled("p1");
    relay.kill();
    await released;
    expect(hooks.answer("p1", "touch marker-c.txt", "Yes")).toBe(false);
  });
});

it("shows the whole command under Claude's words for it", () => {
  expect(heldBody({ command: "touch a", description: "Create a" })).toBe("Create a\ntouch a");
  expect(heldBody({ command: "touch a", description: null })).toBe("touch a");
});
