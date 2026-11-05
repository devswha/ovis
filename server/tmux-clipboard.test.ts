import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TMUX_COPY_BYTES, TMUX_HOOK_HEADER, TmuxCopyHooks, tmuxSocketOf, type TmuxCopyOptions } from "./tmux-clipboard.ts";

describe("the socket a tmux client connects to", () => {
  it("reads -S, then -L, then tmux's default, and nothing that is not tmux", () => {
    expect(tmuxSocketOf(["tmux", "-S", "/run/s", "attach"], "/tmp", 1000)).toBe("/run/s");
    expect(tmuxSocketOf(["/usr/bin/tmux", "-uS/run/s", "a"], "/tmp", 1000)).toBe("/run/s");
    expect(tmuxSocketOf(["tmux", "-L", "work", "new", "-S", "ignored"], "/tmp", 1000)).toBe("/tmp/tmux-1000/work");
    expect(tmuxSocketOf(["tmux", "-f", "/etc/conf", "new", "-s", "x"], "/var/t", 501)).toBe("/var/t/tmux-501/default");
    expect(tmuxSocketOf(["tmux", "-S"], "/tmp", 1000)).toBeNull();
    expect(tmuxSocketOf(["sh", "-c", "tmux"], "/tmp", 1000)).toBeNull();
  });
});

const tmuxProgram = Bun.which("tmux");
const PORT = 45_678;

describe.skipIf(tmuxProgram === null || process.platform === "win32")("tmux copy hooks", () => {
  const tmux = tmuxProgram!;
  let dir: string;
  let socket: string;
  let client: Bun.Subprocess;
  let clientPid: number;
  let argv: string[];

  const run = async (...args: string[]): Promise<string> => {
    const child = Bun.spawn([tmux, "-S", socket, ...args], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new Error(`tmux ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`);
    return out.trim();
  };
  const hooks = () => run("show-hooks", "-g", "pane-set-clipboard");

  /** a manager on a fixture: `on` the setting, `shown` the panes a browser shows, each running the tmux client */
  function manager(state: { on: boolean; shown: string[] }, copies: [string, string][]) {
    const listeners = new Set<() => void>();
    const options: TmuxCopyOptions = {
      stateDir: dir, port: () => PORT, enabled: () => state.on, sweepMs: 60_000,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      shownPanes: () => state.shown,
      foreground: async (paneId) => paneId === "pane-shell" ? [{ pid: 1, argv: ["bash"] }] : [{ pid: clientPid, argv }],
      capture: () => (paneId, text) => { copies.push([paneId, text]); },
      tmux, curl: Bun.which("curl") ?? "/usr/bin/curl",
    };
    return new TmuxCopyHooks(options);
  }
  const secret = () => readFileSync(join(dir, `tmux-hook-${PORT}.header`), "utf8").split(": ")[1]!.trim();
  const post = (fields: Record<string, string>, headers: Record<string, string> = { [TMUX_HOOK_HEADER]: secret() }) =>
    new Request(`http://127.0.0.1:${PORT}/api/tmux/copied`, { method: "POST", headers: { host: `127.0.0.1:${PORT}`, ...headers }, body: new URLSearchParams(fields) });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ovis-tmux-copy-"));
    socket = join(dir, "sock");
    await run("-f", "/dev/null", "new-session", "-d", "-s", "one", "-x", "80", "-y", "24", "sh");
    await run("new-window", "-d", "-t", "one", "sh");
    // the user's own hook on the same event, which Ovis must leave as it is
    await run("set-hook", "-g", "pane-set-clipboard[0]", "run-shell true");
    // a client in a pty, as a herdr pane running `tmux attach` holds one; it draws once it is attached
    argv = [tmux, "-S", socket, "attach", "-t", "one"];
    const drawn = Promise.withResolvers<void>();
    client = Bun.spawn(argv, { env: { ...process.env, TERM: "xterm-256color" }, terminal: { cols: 80, rows: 24, data: () => drawn.resolve() } });
    clientPid = client.pid;
    await drawn.promise;
    expect((await run("list-clients", "-F", "#{client_pid}")).split("\n")).toContain(String(clientPid));
  });

  afterAll(async () => {
    client?.kill();
    await run("kill-server").catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("sets no hook while the setting is off, its own beside the user's once on, and takes it away when off again", async () => {
    const state = { on: false, shown: ["pane-tmux"] };
    const copies: [string, string][] = [];
    const hooked = manager(state, copies);
    try {
      await hooked.sweep();
      expect(await hooks()).not.toContain(`[${PORT}]`);
      state.on = true;
      await hooked.sweep();
      const set = await hooks();
      expect(set).toContain("pane-set-clipboard[0] run-shell true");
      expect(set).toContain(`pane-set-clipboard[${PORT}]`);
      expect(set).toContain(`127.0.0.1:${PORT}/api/tmux/copied`);
      // the secret is in a file only this user reads, and not in the hook's command line
      expect(statSync(join(dir, `tmux-hook-${PORT}.header`)).mode & 0o777).toBe(0o600);
      expect(set).not.toContain(secret());
      state.on = false;
      await hooked.sweep();
      expect(await hooks()).toBe("pane-set-clipboard[0] run-shell true");
    } finally {
      await hooked.stop();
    }
  });

  it("takes the hook away when no browser shows the pane, and when the server stops", async () => {
    const state = { on: true, shown: ["pane-tmux"] };
    const hooked = manager(state, []);
    await hooked.sweep();
    expect(await hooks()).toContain(`[${PORT}]`);
    state.shown = [];
    await hooked.sweep();
    expect(await hooks()).not.toContain(`[${PORT}]`);
    state.shown = ["pane-tmux"];
    await hooked.sweep();
    expect(await hooks()).toContain(`[${PORT}]`);
    await hooked.stop();
    expect(await hooks()).toBe("pane-set-clipboard[0] run-shell true");
  });

  it("unsets on its next start the hook a server that ended without stopping left, and never a hook of the user's at its index", async () => {
    const crashed = manager({ on: true, shown: ["pane-tmux"] }, []);
    await crashed.sweep();
    expect(await hooks()).toContain(`[${PORT}]`);
    // the next run of this server, with the setting off: what the last one listed goes
    const next = manager({ on: false, shown: ["pane-tmux"] }, []);
    await next.sweep();
    expect(await hooks()).toBe("pane-set-clipboard[0] run-shell true");
    await next.stop();
    // the user's own hook at this server's index is neither replaced nor unset
    await run("set-hook", "-g", `pane-set-clipboard[${PORT}]`, "run-shell mine");
    const beside = manager({ on: true, shown: ["pane-tmux"] }, []);
    await beside.sweep();
    expect(await hooks()).toContain(`pane-set-clipboard[${PORT}] run-shell mine`);
    await beside.stop();
    expect(await hooks()).toContain(`pane-set-clipboard[${PORT}] run-shell mine`);
    await run("set-hook", "-gu", `pane-set-clipboard[${PORT}]`);
  });

  it("brings a copy to the pane whose tmux client shows the copying window, and to no other", async () => {
    const copies: [string, string][] = [];
    const state = { on: true, shown: ["pane-tmux", "pane-shell"] };
    const hooked = manager(state, copies);
    try {
      await hooked.sweep();
      const shown = await run("display-message", "-p", "-t", "one:0", "#{pane_id}");
      const hidden = await run("display-message", "-p", "-t", "one:1", "#{pane_id}");
      await run("set-buffer", "copied in tmux ✓");
      expect((await hooked.handle(post({ socket, pane: shown }), "127.0.0.1")).status).toBe(204);
      expect(copies).toEqual([["pane-tmux", "copied in tmux ✓"]]);
      // two copies before the hook's post is read: which window each came from cannot be told, so neither goes
      await run("set-buffer", "made in the window behind");
      await run("set-buffer", "made here");
      expect((await hooked.handle(post({ socket, pane: shown }), "127.0.0.1")).status).toBe(204);
      expect(copies).toEqual([["pane-tmux", "copied in tmux ✓"]]);
      // with a buffer-limit of one, a copy in the other window drops this one before its post is read: the one
      // buffer left is the other window's, and its number skips the one dropped, so nothing goes
      await run("set", "-g", "buffer-limit", "1");
      await run("set-buffer", "copied here, then dropped");
      await run("set-buffer", "copied in the window behind");
      expect((await hooked.handle(post({ socket, pane: shown }), "127.0.0.1")).status).toBe(204);
      expect(copies).toEqual([["pane-tmux", "copied in tmux ✓"]]);
      await run("set", "-g", "buffer-limit", "50");
      await run("set-buffer", "from the window behind");
      expect((await hooked.handle(post({ socket, pane: hidden }), "::1")).status).toBe(204);
      const big = join(dir, "big");
      writeFileSync(big, "x".repeat(MAX_TMUX_COPY_BYTES + 1));
      await run("load-buffer", big);
      expect((await hooked.handle(post({ socket, pane: shown }), "127.0.0.1")).status).toBe(204);
      expect(copies).toEqual([["pane-tmux", "copied in tmux ✓"]]);
      // the setting turned off: a hook still set is not taken, even before the sweep unsets it
      state.on = false;
      await run("set-buffer", "after off");
      expect((await hooked.handle(post({ socket, pane: shown }), "127.0.0.1")).status).toBe(404);
      expect(copies).toEqual([["pane-tmux", "copied in tmux ✓"]]);
    } finally {
      await hooked.stop();
    }
  });

  it("takes a copy only from its own hook: loopback, its secret, no proxy or page, a tmux it hooked", async () => {
    const copies: [string, string][] = [];
    const hooked = manager({ on: true, shown: ["pane-tmux"] }, copies);
    try {
      await hooked.sweep();
      const pane = await run("display-message", "-p", "-t", "one:0", "#{pane_id}");
      await run("set-buffer", "planted");
      const fields = { socket, pane };
      const refused = await Promise.all([
        hooked.handle(post(fields, {}), "127.0.0.1"),
        hooked.handle(post(fields, { [TMUX_HOOK_HEADER]: "1" }), "127.0.0.1"),
        hooked.handle(post(fields), "127.0.0.2"),
        hooked.handle(post(fields), "192.168.1.50"),
        hooked.handle(post(fields), null),
        hooked.handle(post(fields, { [TMUX_HOOK_HEADER]: secret(), "x-forwarded-for": "100.64.0.9" }), "127.0.0.1"),
        hooked.handle(post(fields, { [TMUX_HOOK_HEADER]: secret(), origin: `http://127.0.0.1:${PORT}` }), "127.0.0.1"),
      ]);
      expect(refused.map((answer) => answer.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
      const other = join(dir, "not-hooked");
      writeFileSync(other, "");
      expect((await hooked.handle(post({ socket: other, pane }), "127.0.0.1")).status).toBe(403);
      expect((await hooked.handle(post({ socket: "relative", pane }), "127.0.0.1")).status).toBe(400);
      expect(copies).toEqual([]);
    } finally {
      await hooked.stop();
    }
  });
});
