import { join } from "node:path";
import { isolate } from "./check.ts";

export async function runOnOwnHerdr(what: string, run: () => Promise<unknown>): Promise<void> {
  if (process.env.HERDR_TEST_LIVE === "1") throw new Error(`Cannot run live ${what} with HERDR_TEST_LIVE=1`);
  if (process.env.HERDR_TEST_MODE === "unit") throw new Error(`HERDR_TEST_MODE=unit cannot run live ${what}`);

  const herdr = process.env.OVIS_HERDR_BIN || Bun.which("herdr");
  if (!herdr) throw new Error(`${what} require OVIS_HERDR_BIN or a herdr binary on PATH`);

  const isolation = isolate({ ...process.env, CHECK_DIR: undefined });
  for (const name of Object.keys(process.env)) {
    if (!(name in isolation.env)) delete process.env[name];
  }
  Object.assign(process.env, isolation.env);
  const configRoot = isolation.env.XDG_CONFIG_HOME!;
  const session = isolation.env.HERDR_TEST_SESSION!;
  const socket = join(isolation.sessions, session, "herdr.sock");
  process.env.HERDR_SOCKET = socket;
  process.env.OVIS_HERDR_BIN = herdr;

  let failed = false;
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failed = true;
    failure = error;
  }

  const teardownErrors: unknown[] = [];
  const stopEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HERDR_"))) as Record<string, string>;
  stopEnv.XDG_CONFIG_HOME = configRoot;
  let stopped = false;
  try {
    const result = Bun.spawnSync([herdr, "--session", session, "server", "stop"], {
      env: stopEnv, timeout: 10_000, stdout: "inherit", stderr: "inherit",
    });
    stopped = result.exitCode === 0;
    if (stopped) {
      const { ping } = await import("../server/herdr/client.ts");
      const deadline = Date.now() + 10_000;
      while (await ping(socket).then(() => true, () => false)) {
        if (Date.now() >= deadline) {
          stopped = false;
          break;
        }
        await Bun.sleep(50);
      }
    }
    if (!stopped) teardownErrors.push(new Error(`Owned herdr session ${session} failed to stop (exit ${result.exitCode}); config retained at ${configRoot}`));
  } catch (error) {
    teardownErrors.push(new Error(`Owned herdr stop failed; config retained at ${configRoot}`, { cause: error }));
  }
  if (stopped) {
    try {
      isolation.remove();
    } catch (error) {
      teardownErrors.push(error);
    }
  }

  if (failed) {
    if (teardownErrors.length) console.error(new AggregateError(teardownErrors, `${what}: teardown failed after the run failed`));
    throw failure;
  }
  if (teardownErrors.length) throw new AggregateError(teardownErrors, `${what}: teardown failed`);
}
