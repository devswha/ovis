import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreStartEnv, loginTerminalEnv } from "./terminal-env.ts";

const dir = mkdtempSync(join(tmpdir(), "ovis-terminal-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const win = process.platform === "win32";

function homeWith(profile: string): string {
  const home = mkdtempSync(join(dir, "home-"));
  writeFileSync(join(home, ".profile"), profile);
  return home;
}

/** a server an agent's shell started: colour off, the agent's own variable, Ovis's own and the herdr pane's */
const fromAgent = (home: string) => ({
  HOME: home, PATH: "/usr/bin:/bin", SHELL: "/bin/sh", LANG: "C.UTF-8", SSH_AUTH_SOCK: join(dir, "agent.sock"),
  TERM: "dumb", COLORTERM: "", NO_COLOR: "1", AGENT_SESSION_VAR: "agent",
  PORT: "7317", OVIS_TOKEN: "secret", HERDR_PANE_ID: "w1:p1", HC_TERMINAL_ID: "t9",
});

it.skipIf(win)("gives a terminal the login shell's environment in colour, without the agent's or Ovis's own variables", async () => {
  // regression: a core an agent's shell started gave every pane its NO_COLOR, and none of the tokens the profile exports
  const env = await loginTerminalEnv({ env: fromAgent(homeWith("export GH_TOKEN=from-profile\n")), shell: "/bin/sh" });
  expect(env).toMatchObject({ GH_TOKEN: "from-profile", TERM: "xterm-256color", COLORTERM: "truecolor", NO_COLOR: "", LANG: "C.UTF-8", SSH_AUTH_SOCK: join(dir, "agent.sock") });
  for (const name of ["AGENT_SESSION_VAR", "PORT", "OVIS_TOKEN", "HERDR_PANE_ID", "HC_TERMINAL_ID", "PWD", "OLDPWD", "SHLVL", "_"]) expect(env).not.toHaveProperty(name);
});

it.skipIf(win)("keeps NO_COLOR when the user's own login sets it", async () => {
  const env = await loginTerminalEnv({ env: fromAgent(homeWith("export NO_COLOR=yes\n")), shell: "/bin/sh" });
  expect(env["NO_COLOR"]).toBe("yes");
});

it.skipIf(win)("still asks for colour when the login shell gives nothing", async () => {
  expect(await loginTerminalEnv({ env: fromAgent(homeWith("exit 3\n")), shell: "/bin/sh" })).toEqual({ TERM: "xterm-256color", COLORTERM: "truecolor" });
});

it("starts a core in the terminal environment, found where the server's own variables say", () => {
  const server = { HOME: "/home/u", HC_SESSION: "s", HC_SOCKET: "/r/hc.sock", XDG_RUNTIME_DIR: "/r", XDG_STATE_HOME: "/st", NO_COLOR: "1", PATH: "/a" };
  const terminal = { HOME: "/elsewhere", XDG_RUNTIME_DIR: "/x", XDG_STATE_HOME: "/y", NO_COLOR: "", PATH: "/b", GH_TOKEN: "from-profile" };
  expect(coreStartEnv(server, terminal)).toEqual({ ...server, NO_COLOR: "", PATH: "/b", GH_TOKEN: "from-profile" });
});
