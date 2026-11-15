import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as herdr from "./herdr/client.ts";
import * as runtime from "./herdr-core/runtime.ts";
import * as shellAgent from "./shell-agent.ts";
import { agentLaunch, dshEffortArgs } from "./agent-launch.ts";
import { launchedAgents } from "./launched-agents.ts";

const ULTRACODE = JSON.stringify({ ultracode: true });
const PANE = "agent-launch-test-pane";

describe("agentLaunch", () => {
  /** what herdr's agent.start was asked, without a herdr */
  const starts: Parameters<typeof herdr.agentStart>[0][] = [];
  const roots: string[] = [];
  afterEach(() => {
    starts.length = 0;
    launchedAgents.forget(PANE);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const settingsDir = (): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-agent-launch-")));
    roots.push(root);
    return join(root, "claude-settings");
  };
  const launch = async (kind: string, args: string[], options: { platform: string; settingsDir: string }) => {
    const start = spyOn(herdr, "agentStart").mockImplementation(async (params) => { starts.push(params); return {}; });
    try {
      expect(await agentLaunch(PANE, { kind, name: `${kind}-launch-test`, args }, undefined, undefined, options)).toEqual({ agent_started: true });
    } finally {
      start.mockRestore();
    }
    expect(starts).toHaveLength(1);
    return starts[0]!;
  };

  it("starts Claude Code on Windows with its inline JSON --settings as a file's path", async () => {
    const dir = settingsDir();
    const args = ["--effort", "medium", "--settings", ULTRACODE];
    const started = await launch("claude", args, { platform: "win32", settingsDir: dir });
    expect(started).toMatchObject({ name: "claude-launch-test", kind: "claude", paneId: PANE });
    expect(started.args!.slice(0, 3)).toEqual(["--effort", "medium", "--settings"]);
    expect(dirname(started.args![3]!)).toBe(dir);
    expect(readFileSync(started.args![3]!, "utf8")).toBe(ULTRACODE);
    // the request's own args are left as they came
    expect(args).toEqual(["--effort", "medium", "--settings", ULTRACODE]);
  });

  it("hands the args on as they came off Windows, and another agent's on Windows", async () => {
    const dir = settingsDir();
    const claude = ["--effort", "medium", "--settings", ULTRACODE];
    expect((await launch("claude", claude, { platform: "linux", settingsDir: dir })).args).toBe(claude);
    starts.length = 0;
    const codex = ["--settings", ULTRACODE];
    expect((await launch("codex", codex, { platform: "win32", settingsDir: dir })).args).toBe(codex);
    expect(existsSync(dir)).toBe(false);
  });

  it("takes a dsh-tui launch's --effort off its command line, before -- only, and keeps only a level the check takes", () => {
    expect(dshEffortArgs([])).toEqual({ args: [], effort: undefined });
    expect(dshEffortArgs(["--effort", "low"])).toEqual({ args: [], effort: "low" });
    expect(dshEffortArgs(["--effort=off", "/tmp/project"])).toEqual({ args: ["/tmp/project"], effort: "off" });
    // after -- everything is passed on as it is, as launchArgsFault stops reading there
    expect(dshEffortArgs(["--", "--effort", "bogus"])).toEqual({ args: ["--", "--effort", "bogus"], effort: undefined });
    expect(dshEffortArgs(["--effort", "high", "--", "--effort=max"])).toEqual({ args: ["--", "--effort=max"], effort: "high" });
    expect(dshEffortArgs(["--effort", "medium"]).effort).toBeUndefined();
  });

  describe("a dsh-tui start", () => {
    const home = (): string => dirname(settingsDir());
    const effortFile = (root: string): string => join(root, ".dsh-tui", "effort.json");
    const saved = (root: string): unknown => JSON.parse(readFileSync(effortFile(root), "utf8"));
    /** startShellAgent stood in for: each call recorded with what the effort file held then, answered by the test */
    const shellStarts = (root: string) => {
      const calls: { kind: string; args: string[] | undefined; file: string | null; finish: (pid: number | null) => void; fail: (error: Error) => void }[] = [];
      const waiting: (() => void)[] = [];
      const spy = spyOn(shellAgent, "startShellAgent").mockImplementation((kind, _pane, args) => new Promise((resolve, reject) => {
        calls.push({ kind, args, file: existsSync(effortFile(root)) ? readFileSync(effortFile(root), "utf8") : null, finish: resolve, fail: reject });
        waiting.splice(0).forEach((wake) => wake());
      }));
      const called = async (count: number): Promise<void> => {
        while (calls.length < count) await new Promise<void>((wake) => waiting.push(wake));
      };
      return { calls, called, restore: () => spy.mockRestore() };
    };

    it("saves the checked level where dsh-tui's /effort does and types the command without it", async () => {
      const root = home();
      const shell = shellStarts(root);
      try {
        const launched = agentLaunch(PANE, { kind: "dsh-tui", args: ["--effort", "low", "/tmp/project"] }, undefined, undefined, { home: root });
        await shell.called(1);
        expect(shell.calls[0]!.args).toEqual(["/tmp/project"]);
        expect(JSON.parse(shell.calls[0]!.file!)).toEqual({ effort: "low" });
        shell.calls[0]!.finish(4242);
        expect(await launched).toEqual({ agent_started: true });
        expect(saved(root)).toEqual({ effort: "low" });
      } finally {
        shell.restore();
      }
    });

    it("saves nothing for another agent, for an effort after --, or with no home", async () => {
      const root = home();
      const shell = shellStarts(root);
      try {
        const answers = [
          agentLaunch(PANE, { kind: "gjc", args: ["--effort", "low"] }, undefined, undefined, { home: root }),
          agentLaunch(PANE, { kind: "dsh-tui", args: ["--", "--effort", "bogus"] }, undefined, undefined, { home: root }),
          agentLaunch(PANE, { kind: "dsh-tui", args: ["--effort", "max"] }, undefined, undefined, { home: "" }),
        ];
        await shell.called(3);
        expect(shell.calls.map((call) => call.args)).toEqual([["--effort", "low"], ["--", "--effort", "bogus"], []]);
        for (const call of shell.calls) call.finish(null);
        expect(await Promise.all(answers)).toEqual([{ agent_started: true }, { agent_started: true }, { agent_started: true }]);
        expect(existsSync(join(root, ".dsh-tui"))).toBeFalse();
        // no home is not the server's working folder
        expect(existsSync(join(process.cwd(), ".dsh-tui"))).toBeFalse();
      } finally {
        shell.restore();
      }
    });

    it("puts the saved level back as it was when dsh-tui does not start", async () => {
      const root = home();
      mkdirSync(join(root, ".dsh-tui"));
      writeFileSync(effortFile(root), JSON.stringify({ effort: "high" }));
      const fresh = home();
      const shell = shellStarts(root);
      try {
        const kept = agentLaunch(PANE, { kind: "dsh-tui", args: ["--effort", "off"] }, undefined, undefined, { home: root });
        await shell.called(1);
        expect(saved(root)).toEqual({ effort: "off" });
        shell.calls[0]!.fail(new Error("dsh-tui did not start in the pane"));
        expect(await kept).toMatchObject({ agent_started: false, error: { message: "dsh-tui did not start in the pane" } });
        expect(saved(root)).toEqual({ effort: "high" });

        const none = agentLaunch(PANE, { kind: "dsh-tui", args: ["--effort", "low"] }, undefined, undefined, { home: fresh });
        await shell.called(2);
        expect(saved(fresh)).toEqual({ effort: "low" });
        shell.calls[1]!.fail(new Error("dsh-tui is not on this server's PATH or its login shell's"));
        expect(await none).toMatchObject({ agent_started: false });
        expect(existsSync(effortFile(fresh))).toBeFalse();
      } finally {
        shell.restore();
      }
    });

    it("lets a second launch change the level only once the first one's dsh-tui has started", async () => {
      const root = home();
      const shell = shellStarts(root);
      try {
        const first = agentLaunch(PANE, { kind: "dsh-tui", args: ["--effort", "low"] }, undefined, undefined, { home: root });
        const second = agentLaunch(PANE, { kind: "dsh-tui", args: ["--effort", "max"] }, undefined, undefined, { home: root });
        await shell.called(1);
        // the first dsh-tui boots and reads its level while the second launch waits
        expect(saved(root)).toEqual({ effort: "low" });
        shell.calls[0]!.finish(1);
        expect(await first).toEqual({ agent_started: true });
        await shell.called(2);
        expect(JSON.parse(shell.calls[1]!.file!)).toEqual({ effort: "max" });
        shell.calls[1]!.finish(2);
        expect(await second).toEqual({ agent_started: true });
      } finally {
        shell.restore();
      }
    });
  });

  it("refuses a shell-started agent on another machine of the core, typing nothing into its shell", async () => {
    const machine = spyOn(runtime, "hcMachine").mockReturnValue({ name: "lab", id: "lab-id" });
    const typed = spyOn(herdr, "paneSendText").mockImplementation(async () => ({}) as never);
    try {
      const answer = await agentLaunch(PANE, { kind: "gjc" });
      expect(answer).toMatchObject({ agent_started: false, error: { code: "other_machine" } });
      expect(typed).not.toHaveBeenCalled();
    } finally {
      machine.mockRestore();
      typed.mockRestore();
    }
  });
});
