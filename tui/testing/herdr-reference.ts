/**
 * Capture a two-pane layout through herdr's own entry on an isolated PTY: the reference the screen is compared with.
 * Run with a scratch TMPDIR: bun tui/testing/herdr-reference.ts /absolute/herdr
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isolatedHcEnv } from "../../scripts/test-hc.ts";
import { DETACH, entryEnv, entryPty, fresh, visibleGrid } from "./entry-pty.ts";
import { stopAllPtyRuns } from "./pty.ts";

const [herdr] = process.argv.slice(2);
if (!herdr || !isAbsolute(herdr)) throw new Error("pass the absolute path to herdr");
const SESSION = "r32";
const SIZES = [[120, 40], [80, 24]] as const;
const PANES = ["LEFT", "RIGHT"] as const;
const BOTH = "(?:LEFT-READY[\\s\\S]*RIGHT-READY|RIGHT-READY[\\s\\S]*LEFT-READY)";
const active: (() => Promise<void>)[] = [];
let cleaning: Promise<void> | undefined;
// every step runs, also after one failed; the first failure is raised once all of them ran
const stop = () => (cleaning ??= (async () => {
  const failures: unknown[] = [];
  for (const step of [stopAllPtyRuns, ...active.reverse()]) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
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

  for (const [cols, rows] of SIZES) {
    for (const [name, entry, vars] of [["herdr", args, env]] as const) {
      // Start the quiet interval over whenever a chunk of a paint arrives.
      let outputArrived: (() => void) | undefined;
      const run = entryPty(entry, vars, cols, rows, { onData: () => outputArrived?.() });
      const settledGrid = async (complete: (grid: string) => boolean = () => true) => {
        for (;;) {
          const grid = await quietGrid();
          if (complete(grid.text)) return grid.text;
          await run.until(new RegExp(`^[\\s\\S]{${grid.bytes + 1}}`), `${name}: the rest of the frame`);
        }
      };
      const quietGrid = async () => {
        let quiet: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            new Promise<void>((resolve) => {
              outputArrived = () => { clearTimeout(quiet); quiet = setTimeout(resolve, 40); };
              outputArrived();
            }),
            run.exited.then(() => { throw new Error(`${name} exited before the frame settled`); }),
          ]);
        } finally {
          outputArrived = undefined;
          clearTimeout(quiet);
        }
        const bytes = run.output().length;
        return { bytes, text: await visibleGrid(run, cols, rows) };
      };
      await run.until(new RegExp(BOTH), `${name}: both pane markers`);
      const grid = await settledGrid((text) => PANES.every((pane) => text.includes(`${pane}-READY`)) &&
        /└─+┘└─+┘/.test(text.split("\n")[rows - 1] ?? ""));
      console.log(`\n=== ${name} ${cols}x${rows} ===\n${grid.trimEnd()}`);
      if (cols === 80) {
        const from = run.output().length;
        run.type("\x02?");
        await fresh(run, from, "scroll j/k/");
        // the help is whole once its last line, the scroll hint, is on the grid
        console.log(`\n=== ${name} help ${cols}x${rows} ===\n${(await settledGrid((text) => text.includes("scroll j/k/"))).trimEnd()}`);
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
