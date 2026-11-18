/**
 * Capture the same two-pane layout through the herdr and Ovis entries on isolated PTYs.
 * Run with a scratch TMPDIR: bun tui/testing/herdr-reference.ts /absolute/herdr /absolute/hc
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { IsolatedCore, isolatedHcEnv, stoppedCleanly } from "../../scripts/test-hc.ts";
import { HcConnection } from "../../server/herdr-core/connection.ts";
import { PANE_NAME_LABEL, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "../../server/herdr-core/snapshot.ts";
import { connectCoreSocket } from "../../server/herdr-core/socket-transport.ts";
import { DETACH, entryEnv, entryPty, fresh, SOURCE_OVIS, visibleGrid } from "./entry-pty.ts";
import { stopAllPtyRuns } from "./pty.ts";

const [herdr, hc] = process.argv.slice(2);
if (!herdr || !hc || !isAbsolute(herdr) || !isAbsolute(hc)) throw new Error("pass absolute paths to herdr and hc");
const SESSION = "r32";
const SIZES = [[120, 40], [80, 24]] as const;
const PANES = ["LEFT", "RIGHT"] as const;
const BOTH = "(?:LEFT-READY[\\s\\S]*RIGHT-READY|RIGHT-READY[\\s\\S]*LEFT-READY)";
const active: (() => Promise<void>)[] = [];
let cleaning: Promise<void> | undefined;
const stop = () => (cleaning ??= (async () => {
  await stopAllPtyRuns();
  for (const dispose of active.reverse()) await dispose();
})());
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => {
  void stop().finally(() => process.exit(128 + constants.signals[signal]));
});

// Both programs are login-shell stand-ins with identical output and no host startup files.
const SHELL = `#!/bin/sh
if [ -z "$ROW32_PANE" ]; then exit 2; fi
printf '%s-READY\\r\\n' "$ROW32_PANE"
while IFS= read -r line; do printf '%s: %s\\r\\n' "$ROW32_PANE" "$line"; done
`;

try {
  const root = mkdtempSync(join(tmpdir(), "h-"));
  const folders = { root, env: isolatedHcEnv(root, { XDG_CONFIG_HOME: join(root, "c"), PATH: "/usr/bin:/bin" }) };
  const clientPath = join(root, "c", "herdr", "sessions", SESSION, "herdr-client.sock");
  const apiPath = join(root, "c", "herdr", "sessions", SESSION, "herdr.sock");
  if (Buffer.byteLength(clientPath) > 107) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`herdr's client socket exceeds 107 bytes: ${clientPath}`);
  }
  const env = {
    ...entryEnv(folders), HERDR_TEST_SESSION: SESSION, HERDR_SOCKET: apiPath,
    HERDR_CONFIG_PATH: join(root, "herdr.toml"), SHELL: join(root, "fixture-shell"),
  };
  const home = join(root, "home");
  for (const path of [home, join(root, "run")]) mkdirSync(path);
  writeFileSync(env.SHELL, SHELL, { mode: 0o700 });
  writeFileSync(env.HERDR_CONFIG_PATH, "onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n");
  const args = [herdr, "--session", SESSION];
  const server = Bun.spawn([...args, "server"], { cwd: home, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const serverErr = new Response(server.stderr).text();
  async function call(...command: string[]): Promise<string> {
    const child = Bun.spawn([...args, ...command], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`herdr ${command.join(" ")} exited ${code}: ${err}`);
    return out.trim();
  }
  active.push(async () => {
    try {
      if (server.exitCode === null && existsSync(apiPath) && existsSync(clientPath)) await call("server", "stop");
      else if (server.exitCode === null) server.kill("SIGTERM");
    } catch (error) {
      if (server.exitCode === null) server.kill("SIGTERM");
      throw error;
    } finally {
      await server.exited;
      if (existsSync(apiPath) || existsSync(clientPath)) throw new Error(`isolated herdr left a socket at ${root}`);
      rmSync(root, { recursive: true, force: true });
      console.log("herdr cleanup: owned server exited; both scratch sockets removed");
    }
  });
  const limit = performance.now() + 5_000;
  while (!existsSync(apiPath) || !existsSync(clientPath)) {
    if (server.exitCode !== null) throw new Error(`isolated herdr exited ${server.exitCode}: ${await serverErr}`);
    if (performance.now() >= limit) throw new Error(`herdr sockets not ready at ${root}`);
    await Bun.sleep(10);
  }
  console.log(await call("--version"), `API socket ${Buffer.byteLength(apiPath)} bytes, client socket ${Buffer.byteLength(clientPath)} bytes`);
  console.log(`herdr fixture: HOME=${home} SHELL=${env.SHELL} TERM=xterm-256color PATH=${folders.env["PATH"]}`);
  const made: { result: { root_pane: { pane_id: string }; workspace: { workspace_id: string } } } = JSON.parse(await call(
    "workspace", "create", "--cwd", home, "--label", "work", "--env", "ROW32_PANE=LEFT", "--focus",
  ));
  const left = made.result.root_pane.pane_id;
  const workspace = made.result.workspace.workspace_id;
  const tabs: { result: { tabs: { tab_id: string }[] } } = JSON.parse(await call("tab", "list", "--workspace", workspace));
  const tab = tabs.result.tabs[0]?.tab_id;
  if (!tab) throw new Error("the reference workspace has no tab");
  await call("tab", "rename", tab, "one");
  await call("pane", "rename", left, "LEFT");
  const split: { result: { pane: { pane_id: string } } } = JSON.parse(await call(
    "pane", "split", left, "--direction", "right", "--cwd", home, "--env", "ROW32_PANE=RIGHT", "--no-focus",
  ));
  await call("pane", "rename", split.result.pane.pane_id, "RIGHT");

  const core = new IsolatedCore(hc);
  active.push(async () => {
    const report = await core.stop();
    console.log("hc cleanup", JSON.stringify(report));
    if (!stoppedCleanly(report)) throw new Error("isolated hc did not stop");
  });
  await core.start();
  const connection = new HcConnection(await connectCoreSocket(core.socket).then((transport) => () => transport));
  active.push(async () => { connection.close(); });
  console.log("hc", (await connection.hello()).version);
  for (const pane of PANES) {
    await connection.call("terminal.run", {
      argv: [env.SHELL], cwd: home, env: { ROW32_PANE: pane },
      labels: {
        [SPACE_LABEL]: "work", [WORKSPACE_NAME_LABEL]: "work", [TAB_LABEL]: "one",
        [TAB_NAME_LABEL]: "one", [PANE_NAME_LABEL]: pane,
      },
    });
  }
  for (const [cols, rows] of SIZES) {
    for (const [name, entry, vars] of [
      ["herdr", args, env],
      ["Ovis", [...SOURCE_OVIS, "tui"], { ...entryEnv(core, hc), HERDR_TEST_SESSION: SESSION }],
    ] as const) {
      const run = entryPty(entry, vars, cols, rows);
      await run.until(new RegExp(name === "Ovis" ? `${BOTH}[\\s\\S]*\\x1b\\[\\?25h\\x1b\\[\\?2026l` : BOTH), `${name}: both pane markers`);
      const grid = await visibleGrid(run, cols, rows);
      for (const pane of PANES) if (!grid.includes(`${pane}-READY`)) throw new Error(`${name} ${cols}x${rows} missing ${pane}\n${grid}`);
      console.log(`\n=== ${name} ${cols}x${rows} ===\n${grid.trimEnd()}`);
      if (cols === 80) {
        const from = run.output().length;
        run.type("\x02?");
        await fresh(run, from, name === "herdr" ? "scroll j/k/" : "close: esc");
        if (name === "Ovis") await fresh(run, from, "\x1b[?2026l");
        console.log(`\n=== ${name} help ${cols}x${rows} ===\n${(await visibleGrid(run, cols, rows)).trimEnd()}`);
        const leavingHelp = run.output().length;
        run.type("\x1b");
        await fresh(run, leavingHelp, "LEFT-READY");
      }
      run.type(DETACH);
      const end = await run.ended;
      if (end.code !== 0) throw new Error(`${name} detach exited ${end.code}: ${end.stderr}`);
      await run.exited;
    }
  }
} finally {
  await stop();
}
