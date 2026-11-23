import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudePermissionHooks, heldBody, permissionDecision } from "./claude-permission-hook.ts";
import { parseInteractivePrompt } from "./prompt.ts";

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
  /** each pane a request was answered or released for, in order */
  const released: string[] = [];
  const dir = join(root, "hooks");
  const hooks = new ClaudePermissionHooks(dir, {
    ...options, onHeld: (paneId) => waiting.get(paneId)?.(), onSettled: (paneId) => { released.push(paneId); settling.get(paneId)?.(); },
  });
  started.push(hooks);
  const held = (paneId: string) => new Promise<void>((resolve) => waiting.set(paneId, resolve));
  const settled = (paneId: string) => new Promise<void>((resolve) => settling.set(paneId, resolve));
  return { hooks, held, settled, released, dir, root };
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
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "hub.sock")).mode & 0o777).toBe(0o600);
    }
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

  it.skipIf(process.platform === "win32")("adds no hook when its folder is a link to another", () => {
    const { root } = hooksIn();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o755 });
    symlinkSync(elsewhere, join(root, "linked"));
    const hooks = new ClaudePermissionHooks(join(root, "linked"));
    started.push(hooks);
    expect(hooks.launchArgs("p1", ["--model", "opus"])).toEqual(["--model", "opus"]);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
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
    const card = hooks.shown("p1", CARD)!;
    expect(card).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), command: "touch marker-a.txt", description: "Create empty marker-a.txt file" });
    expect(hooks.answer("p2", CARD, card.id, "allow")).toBe(false);
    expect(hooks.answer("p1", CARD, "0".repeat(16), "allow")).toBe(false);
    expect(hooks.answer("p1", "touch marker-b.txt", card.id, "allow")).toBe(false);
    expect(hooks.holds("p1", CARD, card.id)).toBe(true);
    expect(hooks.answer("p1", CARD, card.id, "allow")).toBe(true);
    expect(await answer()).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(hooks.holds("p1", CARD, card.id)).toBe(false);
    expect(hooks.answer("p1", CARD, card.id, "allow")).toBe(false);
  });

  it("answers No as a decline that stops Claude, as the terminal's No does", async () => {
    const { hooks, held } = hooksIn();
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    const holding = held("p1");
    const { answer } = ask(hook, bash("rm -rf build"));
    await holding;
    const screen = "Bash command\nrm -rf build";
    expect(hooks.answer("p1", screen, hooks.shown("p1", screen)!.id, "deny")).toBe(true);
    expect(await answer()).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny", interrupt: true } } });
  });

  it("takes Yes and No from a card as the hook's answer, and leaves every other option to its keys", () => {
    expect(permissionDecision("Yes")).toBe("allow");
    expect(permissionDecision("No")).toBe("deny");
    expect(permissionDecision("No, and tell Claude what to do differently (esc)")).toBe("deny");
    expect(permissionDecision("Yes, and always allow access to /repo from this project")).toBeNull();
    expect(permissionDecision("Yes, and switch to auto mode · auto mode handles these prompts for you")).toBeNull();
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
    const card = hooks.shown("p1", "touch marker-b.txt")!;
    expect(card).not.toBeNull();
    now += 3_000;
    // answered in the terminal: the next read finds no dialog
    expect(hooks.shown("p1", null)).toBeNull();
    expect(await answer()).toEqual({});
    expect(hooks.answer("p1", "touch marker-b.txt", card.id, "allow")).toBe(false);
  });

  it("leaves a Monitor command to the terminal at once", async () => {
    const { hooks } = hooksIn();
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    expect(await ask(hook, { hook_event_name: "PermissionRequest", tool_name: "Monitor", tool_input: { command: "tail -f log" } }).answer()).toEqual({});
  });

  // CodeRabbit on #4480: a command over the card's cap reached the card cut, and its Yes allowed the whole of it
  it("leaves a command the card could not show whole to the terminal at once", async () => {
    const { hooks, held } = hooksIn();
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    const command = `echo ${"a".repeat(16_000)}; touch tail-not-shown.txt`;
    expect(await Promise.race([ask(hook, bash(command)).answer(), held("p1").then(() => "held")])).toEqual({});
    // Claude's words count: the card shows them over the command
    const words = "w".repeat(11_990);
    expect(await Promise.race([ask(hook, bash("touch shown.txt", words)).answer(), held("p1").then(() => "held")])).toEqual({});
  });

  it("holds a command the card shows whole, up to the card's cap", async () => {
    const { hooks, held } = hooksIn();
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    const description = "Print a long line";
    const command = `echo ${"a".repeat(12_000 - description.length - 1 - "echo ".length)}`;
    const holding = held("p1");
    const { answer } = ask(hook, bash(command, description));
    await holding;
    const card = hooks.shown("p1", `${description}\n${command.slice(0, 200)}`)!;
    expect(heldBody(card)).toHaveLength(12_000);
    expect(card.command).toBe(command);
    expect(hooks.answer("p1", command.slice(0, 200), card.id, "allow")).toBe(true);
    expect(await answer()).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
  });

  // CodeRabbit on #4480: A held at 0 ms, B (the same first 40 characters) at 2,000 ms, A's dialog still on the screen at
  // 3,000 ms. The read released A and kept B, and a Yes on the card, which showed A, allowed B.
  it("never lets a card's answer settle another request that starts the same way", async () => {
    let now = 0;
    const { hooks, held, settled, released } = hooksIn({ now: () => now });
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    const start = "git push --force-with-lease origin feature-branch-name";
    const screenA = `Push the branch\n${start} && echo a`;
    let holding = held("p1");
    const a = ask(hook, bash(`${start} && echo a`, "Push the branch"));
    await holding;
    const cardA = hooks.shown("p1", screenA)!;
    expect(cardA.command).toBe(`${start} && echo a`);
    now = 2_000;
    holding = held("p1");
    const b = ask(hook, bash(`${start} && rm -rf ~/b`, "Push the branch"));
    await holding;
    now = 3_000;
    // the screen could show either: both stay held, and the card keeps the screen's text and its keys
    expect(hooks.shown("p1", screenA)).toBeNull();
    expect(released).toEqual([]);
    // the card read at 0 ms showed A: its Yes settles neither
    expect(hooks.holds("p1", screenA, cardA.id)).toBe(false);
    expect(hooks.answer("p1", screenA, cardA.id, "allow")).toBe(false);
    expect(released).toEqual([]);
    // A answered in the terminal and B's dialog drawn: A's hook ends, and B alone is on the card, under an id of its own
    const ended = settled("p1");
    a.relay.kill();
    await ended;
    const screenB = `Push the branch\n${start} && rm -rf ~/b`;
    const cardB = hooks.shown("p1", screenB)!;
    expect(cardB.command).toBe(`${start} && rm -rf ~/b`);
    expect(cardB.id).not.toBe(cardA.id);
    expect(hooks.answer("p1", screenB, cardA.id, "allow")).toBe(false);
    expect(hooks.answer("p1", screenB, cardB.id, "deny")).toBe(true);
    expect(await b.answer()).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
  });

  // an option other than Yes or No goes as keys to the dialog on the screen: only while it is the card's request whole
  it("tells the dialog of the card's request, whole, from one that only starts the same way", async () => {
    const { hooks, held } = hooksIn();
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    const command = "git log --oneline --graph --decorate --all -- server/claude-permission-hook.ts";
    let holding = held("p1");
    const worded = ask(hook, bash(command, "Show the file's history"));
    await holding;
    const wrapped = "Tip: auto mode handles these prompts for you —\nchoose \"switch to auto mode\" below\nShow the file's history\n"
      + "git log --oneline --graph\n  --decorate --all -- server/claude-\n  permission-hook.ts";
    const card = hooks.shown("p1", wrapped)!;
    expect(hooks.showsWhole("p1", wrapped, card.id)).toBe(true);
    // the dialog's command goes on past the card's
    expect(hooks.showsWhole("p1", `Show the file's history\n${command}; rm -rf ~`, card.id)).toBe(false);
    // or the screen cut it
    expect(hooks.showsWhole("p1", `Show the file's history\n${command.slice(0, 60)}`, card.id)).toBe(false);
    // or Claude's words for it are another command's
    expect(hooks.showsWhole("p1", `List the commits\n${command}`, card.id)).toBe(false);
    expect(hooks.showsWhole("p1", wrapped, "0".repeat(16))).toBe(false);
    hooks.stop();
    expect(await worded.answer()).toEqual({});

    const { hooks: bare, held: bareHeld } = hooksIn();
    const bareHook = ourHook(bare.launchArgs("p1", undefined)!);
    holding = bareHeld("p1");
    const unworded = ask(bareHook, bash("pwd"));
    await holding;
    const plain = bare.shown("p1", "pwd")!;
    expect(bare.showsWhole("p1", "pwd", plain.id)).toBe(true);
    // with no words of Claude's, the dialog's text is the command alone
    expect(bare.showsWhole("p1", "pwd; touch extra.txt", plain.id)).toBe(false);
    expect(bare.showsWhole("p1", "Print the folder\npwd", plain.id)).toBe(false);
    bare.stop();
    expect(await unworded.answer()).toEqual({});
  });

  it("tells the card's request, whole, on Claude Code's own dialog", async () => {
    for (const [version, description] of [["2.1.318", "Write short git status to status.txt"], ["2.1.319", "Write short git status output to status.txt"]] as const) {
      const screen = readFileSync(new URL(`./fixtures/claude-diff-panel-${version}-borderless-bash-196.txt`, import.meta.url), "utf8");
      const approval = parseInteractivePrompt("claude", screen)!.body!;
      const { hooks, held } = hooksIn();
      const hook = ourHook(hooks.launchArgs("p1", undefined)!);
      const holding = held("p1");
      const { answer } = ask(hook, bash("git status --short > status.txt", description));
      await holding;
      const card = hooks.shown("p1", approval)!;
      expect(heldBody(card), version).toBe(approval);
      expect(hooks.showsWhole("p1", approval, card.id), version).toBe(true);
      hooks.stop();
      expect(await answer()).toEqual({});
    }
  });

  it("forgets a request whose hook Claude ended", async () => {
    const { hooks, held, settled } = hooksIn();
    const hook = ourHook(hooks.launchArgs("p1", undefined)!);
    const holding = held("p1");
    const { relay } = ask(hook, bash("touch marker-c.txt"));
    await holding;
    const card = hooks.shown("p1", "touch marker-c.txt")!;
    const released = settled("p1");
    relay.kill();
    await released;
    expect(hooks.answer("p1", "touch marker-c.txt", card.id, "allow")).toBe(false);
  });
});

it("shows the whole command under Claude's words for it", () => {
  expect(heldBody({ command: "touch a", description: "Create a" })).toBe("Create a\ntouch a");
  expect(heldBody({ command: "touch a", description: null })).toBe("touch a");
});
