/** Isolated real hc fixtures. No hc call may escape the helper's explicit environment. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcConnection, spawnHcConnect } from "../herdr-core/connection.ts";

/** hc 0.1.18 starts a holder per terminal after startup. Include those and their programs by
 * their two inherited isolation paths, never by a command-name pattern or another account's PID. */
export function killCoreFixtureProcesses(root: string): number[] {
  if (process.platform !== "linux") return [];
  const pids: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let vars: string[];
    try { vars = readFileSync(`/proc/${name}/environ`, "utf8").split("\0"); } catch { continue; }
    if (vars.some((value) => value.startsWith(`HC_SOCKET=${root}/`)) && vars.some((value) => value.startsWith(`XDG_STATE_HOME=${root}/`))) pids.push(Number(name));
  }
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
  return pids;
}

export function coreFixture(bin: string) {
  const root = mkdtempSync(join(tmpdir(), "fleet-hc-"));
  for (const name of ["home", "state", "config", "run"]) mkdirSync(join(root, name), { mode: 0o700 });
  const env: Record<string, string> = {
    HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "run"),
    HC_SESSION: "fleet-test", HC_SOCKET: join(root, "run/herdr-core/fleet-test.sock"),
    OVIS_HC_BIN: bin, PATH: process.env["PATH"] ?? "/usr/bin:/bin", SHELL: "/bin/bash", TMPDIR: tmpdir(),
  };
  mkdirSync(join(root, "run/herdr-core"), { mode: 0o700 });
  const pids = new Set<number>();
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let corePid: number | undefined;
  const isolated = () => {
    for (const name of ["HOME", "HC_SESSION", "HC_SOCKET", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"]) {
      if (!env[name] || (name !== "HC_SESSION" && !env[name]!.startsWith(root + "/"))) throw new Error(`Refusing hc without isolated ${name}`);
    }
    return env;
  };
  const run = async (args: string[]) => {
    const child = Bun.spawn([bin, ...args], { env: isolated(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    children.push(child);
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Isolated hc ${args.join(" ")} exited ${code}: ${err}`);
    return out;
  };
  // Socket-only client: this fixture explicitly starts its core; a request can never replace it.
  const hc = new HcConnection(() => spawnHcConnect(bin, isolated(), true));
  return {
    root, env, hc, run,
    async start() {
      await run(["server", "start"]);
      const status = JSON.parse(await run(["server", "status", "--json"])) as { pid: number; holder?: { pid: number } };
      corePid = status.pid; pids.add(status.pid);
      if (status.holder) pids.add(status.holder.pid);
      return status;
    },
    killCore() {
      if (!corePid) throw new Error("No fixture core has been started");
      process.kill(corePid, "SIGKILL");
    },
    async close() {
      hc.close();
      for (const child of children) { child.kill(); await child.exited; }
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
      killCoreFixtureProcesses(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
