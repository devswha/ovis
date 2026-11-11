import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreStartEnv, loginTerminalEnv, userTerminalEnv } from "./terminal-env.ts";

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
  expect(env).toMatchObject({ GH_TOKEN: "from-profile", TERM: "xterm-256color", COLORTERM: "truecolor", NO_COLOR: "", LANG: "C.UTF-8" });
  for (const name of ["SSH_AUTH_SOCK", "AGENT_SESSION_VAR", "PORT", "OVIS_TOKEN", "HERDR_PANE_ID", "HC_TERMINAL_ID", "PWD", "OLDPWD", "SHLVL", "_"]) expect(env).not.toHaveProperty(name);
});

it.skipIf(win)("keeps NO_COLOR when the user's own login sets it", async () => {
  const env = await loginTerminalEnv({ env: fromAgent(homeWith("export NO_COLOR=yes\n")), shell: "/bin/sh" });
  expect(env["NO_COLOR"]).toBe("yes");
});

it.skipIf(win)("still asks for colour, and turns an inherited NO_COLOR off, when the login shell gives nothing", async () => {
  expect(await loginTerminalEnv({ env: fromAgent(homeWith("exit 3\n")), shell: "/bin/sh" })).toEqual({ TERM: "xterm-256color", COLORTERM: "truecolor", NO_COLOR: "" });
});

it.skipIf(win)("reads an exported bash function and a value holding newlines as what they are", async () => {
  // regression: read line by line, the function's body went into PATH and a value's `API_TOKEN=…` line became a variable
  const home = homeWith("greet() { echo hi; }\nexport -f greet\nexport MULTI='first\nAPI_TOKEN=inside-a-value'\n");
  const env = await loginTerminalEnv({ env: { ...fromAgent(home), SHELL: "/bin/bash" }, shell: "/bin/bash" });
  expect(env["MULTI"]).toBe("first\nAPI_TOKEN=inside-a-value");
  expect(env["PATH"]).toStartWith("/usr/bin:/bin");
  expect(env["PATH"]).not.toContain("\n");
  expect(env).not.toHaveProperty("API_TOKEN");
  expect(Object.keys(env).filter((name) => name.includes("greet"))).toEqual([]);
});

it.skipIf(win)("keeps the probe's own agent, tty and session out of the panes", async () => {
  // regression: `eval $(ssh-agent)` in the profile gave every pane the probe's keyless agent, GPG_TTY read "not a tty"
  const home = homeWith(`export SSH_AUTH_SOCK=${join(dir, "probe.sock")} SSH_AGENT_PID=123 GPG_TTY='not a tty' DISPLAY=:9 GH_TOKEN=from-profile\n`);
  const env = await loginTerminalEnv({ env: fromAgent(home), shell: "/bin/sh" });
  expect(env["GH_TOKEN"]).toBe("from-profile");
  for (const name of ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_TTY", "DISPLAY"]) expect(env).not.toHaveProperty(name);
});

it.skipIf(win)("reads the login shell again after it gave nothing, and keeps what it gave once it did", async () => {
  const home = homeWith(`[ -e "$HOME/ready" ] || exit 3\nexport GH_TOKEN="$(cat "$HOME/ready")"\n`);
  const env = { ...fromAgent(home), SHELL: "/bin/sh" };
  expect(await userTerminalEnv(env)).not.toHaveProperty("GH_TOKEN");
  writeFileSync(join(home, "ready"), "first");
  expect((await userTerminalEnv(env))["GH_TOKEN"]).toBe("first");
  writeFileSync(join(home, "ready"), "second");
  expect((await userTerminalEnv(env))["GH_TOKEN"]).toBe("first");
});

it("starts a core in the terminal environment, found where the server's own variables say", () => {
  const server = { HOME: "/home/u", HC_SESSION: "s", HC_SOCKET: "/r/hc.sock", XDG_RUNTIME_DIR: "/r", XDG_STATE_HOME: "/st", NO_COLOR: "1", PATH: "/a" };
  // the profile's XDG_CONFIG_HOME, which the server has none of, would point hc at another core's settings (hc then defaults it from HOME)
  const terminal = { HOME: "/elsewhere", XDG_RUNTIME_DIR: "/x", XDG_STATE_HOME: "/y", XDG_CONFIG_HOME: "/z", HC_SESSION: "other", NO_COLOR: "", PATH: "/b", GH_TOKEN: "from-profile" };
  expect(coreStartEnv(server, terminal)).toEqual({ ...server, NO_COLOR: "", PATH: "/b", GH_TOKEN: "from-profile" });
});
