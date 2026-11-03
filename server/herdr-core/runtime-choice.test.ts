import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrCoreFacts } from "../../shared/machines.ts";
import { chooseRuntime, runtimeLock, runtimeService, runtimeTraces } from "./runtime-choice.ts";
import { readSavedRuntime, restoreRuntime, saveRuntime } from "./runtime-file.ts";

let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** a home and a state folder of their own, and an environment that points nothing at the developer's */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "ovis-runtime-choice-"));
  cleanup = () => rmSync(root, { recursive: true, force: true });
  const home = join(root, "home");
  const state = join(root, "state");
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = { HOME: home, PATH: join(root, "empty"), XDG_CONFIG_HOME: join(home, ".config"), XDG_RUNTIME_DIR: join(root, "run"), HC_SESSION: "test" };
  const touch = (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, ""); };
  return { root, home, state, env, touch };
}

const core = { bin: "/stand-in/herdr-core", version: "0.1.17" };

it("reads the PC's traces from files alone", () => {
  const { home, env, touch, root } = scratch();
  expect(runtimeTraces({ env, home, platform: "linux" })).toEqual({ tuiInstalled: false, tuiRunning: false, appInstalled: false, coreRunning: false });
  touch(join(home, ".config", "herdr", "config.toml"));
  touch(join(home, ".config", "herdr", "herdr.sock"));
  mkdirSync(join(home, ".local", "share", "herdr-app"), { recursive: true });
  touch(join(root, "run", "herdr-core", "test.sock"));
  expect(runtimeTraces({ env, home, platform: "linux" })).toEqual({ tuiInstalled: true, tuiRunning: true, appInstalled: true, coreRunning: true });
});

it("keeps herdr wherever herdr's TUI left a trace, without looking for hc", async () => {
  const { home, state, env, touch, root } = scratch();
  mkdirSync(join(home, ".local", "share", "herdr-app"), { recursive: true });
  touch(join(root, "run", "herdr-core", "test.sock"));
  let looked = 0;
  const find = async () => { looked += 1; return core; };
  for (const trace of [join(home, ".config", "herdr", "config.toml"), join(home, ".local", "bin", "herdr"), join(home, ".config", "herdr", "herdr.sock")]) {
    touch(trace);
    expect(await chooseRuntime({ stateDir: state, env, home, platform: "linux", find })).toMatchObject({ runtime: "herdr", source: "detected" });
    rmSync(trace);
  }
  expect(looked).toBe(0);
});

it("chooses herdr-core on a PC with no TUI, a verified hc and the Herdr app or its running core", async () => {
  const { home, state, env, touch, root } = scratch();
  // neither the app nor a core: nothing is looked for
  let looked = 0;
  const find = async () => { looked += 1; return core; };
  expect(await chooseRuntime({ stateDir: state, env, home, platform: "linux", find })).toMatchObject({ runtime: "herdr" });
  expect(looked).toBe(0);
  mkdirSync(join(home, ".local", "share", "herdr-app"), { recursive: true });
  expect(await chooseRuntime({ stateDir: state, env, home, platform: "linux", find })).toMatchObject({ runtime: "herdr-core", source: "detected" });
  // the app, but no hc that answers --version as herdr-core's
  expect(await chooseRuntime({ stateDir: state, env, home, platform: "linux", find: async () => null })).toMatchObject({ runtime: "herdr" });
  rmSync(join(home, ".local", "share", "herdr-app"), { recursive: true });
  touch(join(root, "run", "herdr-core", "test.sock"));
  expect(await chooseRuntime({ stateDir: state, env, home, platform: "linux", find })).toMatchObject({ runtime: "herdr-core", source: "detected" });
});

it("takes OVIS_RUNTIME first, then the choice saved in Settings, then the PC's facts", async () => {
  const { home, state, env, touch } = scratch();
  touch(join(home, ".config", "herdr", "config.toml"));
  const find = async () => core;
  saveRuntime(state, { runtime: "herdr-core", previous: "herdr" });
  expect(await chooseRuntime({ stateDir: state, env, home, platform: "linux", find })).toMatchObject({ runtime: "herdr-core", source: "saved" });
  expect(await chooseRuntime({ stateDir: state, env: { ...env, OVIS_RUNTIME: "herdr" }, home, platform: "linux", find })).toMatchObject({ runtime: "herdr", source: "env" });
  await expect(chooseRuntime({ stateDir: state, env: { ...env, OVIS_RUNTIME: "tmux" }, home, platform: "linux", find })).rejects.toThrow(/OVIS_RUNTIME=tmux/);
  // a saved file Ovis cannot read is no choice
  writeFileSync(join(state, "runtime.json"), "{ not json");
  expect(await chooseRuntime({ stateDir: state, env, home, platform: "linux", find })).toMatchObject({ runtime: "herdr", source: "detected" });
});

it("locks the switch when OVIS_RUNTIME decides, the server has no launcher, or herdr-core is not served on the OS", () => {
  expect(runtimeLock({ OVIS_RUNTIME: "herdr-core" }, "linux", true)).toBe("env");
  expect(runtimeLock({}, "linux", false)).toBe("unmanaged");
  expect(runtimeLock({}, "win32", true)).toBe("platform");
  expect(runtimeLock({}, "darwin", true)).toBeNull();
});

it("switches only to a runtime the PC has, saves it with the one it replaces, and asks for one restart", () => {
  const { home, state, env, touch } = scratch();
  touch(join(home, ".config", "herdr", "config.toml"));
  let restarts = 0;
  let coreFacts: HerdrCoreFacts | undefined = { version: null, session: "test", running: false };
  const service = runtimeService({ stateDir: state, serving: "herdr", source: "detected", env, core: () => coreFacts, restart: () => { restarts += 1; }, platform: "linux", managed: true });
  expect(service.facts()).toMatchObject({ serving: "herdr", switch_to: null, locked: null, tui: { installed: true, running: false } });
  expect(service.request("herdr-core")).toMatchObject({ ok: false, status: 409, code: "runtime_unavailable" });
  expect(service.request("tmux")).toMatchObject({ ok: false, status: 400 });
  coreFacts = { version: "0.1.17", session: "test", running: false };
  expect(service.facts().switch_to).toBe("herdr-core");
  expect(service.request("herdr")).toMatchObject({ ok: false, code: "runtime_unavailable" });
  expect(readSavedRuntime(state)).toBeNull();
  expect(restarts).toBe(0);
  expect(service.request("herdr-core")).toEqual({ ok: true });
  expect(readSavedRuntime(state)).toEqual({ runtime: "herdr-core", previous: "herdr" });
  expect(restarts).toBe(1);
  // the restart is under way: a second switch waits for the server that comes next
  expect(service.request("herdr-core")).toMatchObject({ ok: false, code: "runtime_switching" });
  expect(restarts).toBe(1);
});

it("refuses a switch, and saves nothing, where something else decides the runtime", () => {
  const { home, state, env, touch } = scratch();
  touch(join(home, ".config", "herdr", "config.toml"));
  const core = () => ({ version: "0.1.17", session: "test", running: true });
  for (const [options, lock] of [[{ env: { ...env, OVIS_RUNTIME: "herdr" }, managed: true }, "env"], [{ env, managed: false }, "unmanaged"]] as const) {
    const service = runtimeService({ stateDir: state, serving: "herdr", source: "detected", core, restart: () => { throw new Error("no restart"); }, platform: "linux", ...options });
    expect(service.facts()).toMatchObject({ switch_to: null, locked: lock });
    expect(service.request("herdr-core")).toMatchObject({ ok: false, status: 409, code: "runtime_locked" });
  }
  expect(readSavedRuntime(state)).toBeNull();
});

it("puts the previous runtime back after a start on the chosen one failed", () => {
  const { state } = scratch();
  saveRuntime(state, { runtime: "herdr-core", previous: "herdr" });
  restoreRuntime(state);
  expect(readSavedRuntime(state)).toEqual({ runtime: "herdr", previous: null });
  // nothing to go back to: the choice stays
  restoreRuntime(state);
  expect(JSON.parse(readFileSync(join(state, "runtime.json"), "utf8"))).toEqual({ runtime: "herdr", previous: null });
});
