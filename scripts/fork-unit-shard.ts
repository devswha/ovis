/** Fork-only sharding of ci-tests.ts's unit boundary. Keep each file in its own process:
 * combining files in one `bun test` leaks module mocks, and some tests signal their own group. */
import { availableParallelism } from "node:os";

export function selectUnitFiles(cwd = process.cwd()): string[] {
  // Match ci-tests.ts, including all eight roots and its four integration-only exceptions.
  return [...new Bun.Glob("{src,shared,server,scripts,telemetry,push-relay,relay,integrations}/**/*.test.{ts,tsx}").scanSync({ cwd })]
    .filter((file) => !file.endsWith(".contract.test.ts") && file !== "server/updater.test.ts" && !file.startsWith("server/herdr/") && !file.startsWith("server/pty/"))
    .sort();
}

export function unitShard(files: string[], shard: string): string[] {
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(total) || total < 1 || index < 1 || index > total) throw new Error(`Invalid unit shard "${shard}": expected k/n, 1 <= k <= n`);
  return [...files].sort().filter((_, at) => at % total === index - 1);
}

async function run(files: string[]): Promise<number> {
  const requested = Number(process.env["UNIT_TEST_WORKERS"] ?? Math.min(4, availableParallelism()));
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error("UNIT_TEST_WORKERS must be a positive integer");
  const queue = [...files].sort((a, b) => Bun.file(b).size - Bun.file(a).size);
  const running = new Set<number>();
  const failed: string[] = [];
  let interrupted = 0;
  const kill = (pid: number, signal: NodeJS.Signals) => {
    try { process.kill(process.platform === "win32" ? pid : -pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.on(signal, () => {
      if (interrupted) return;
      interrupted = code;
      queue.length = 0;
      for (const pid of running) kill(pid, signal);
      setTimeout(() => { for (const pid of running) kill(pid, "SIGKILL"); process.exit(code); }, 5_000).unref();
    });
  }
  async function worker(): Promise<void> {
    for (let file = queue.shift(); file; file = queue.shift()) {
      console.log(`--- ${file}`);
      const child = Bun.spawn([process.execPath, "test", "--timeout", "60000", `./${file}`], {
        env: { ...process.env, HERDR_TEST_MODE: "unit" }, detached: process.platform !== "win32",
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      running.add(child.pid);
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      let code: number;
      try { code = await child.exited; }
      finally {
        // End descendants before draining pipes they might still hold open.
        kill(child.pid, "SIGKILL");
        running.delete(child.pid);
      }
      const text = (await output).join("\n");
      console.log(text.trimEnd());
      const readable = /^\s*\d+ (?:pass|fail)$/m.test(text.replace(/\x1b\[[0-9;]*m/g, ""));
      if (code !== 0 || !readable) failed.push(file);
    }
  }
  await Promise.all(Array.from({ length: Math.min(requested, files.length) }, worker));
  for (const file of failed) console.log(`FAILED ${file}`);
  console.log(`unit shard: ${files.length} files, ${failed.length} failed`);
  return interrupted || (failed.length ? 1 : 0);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const shard = args[0] === "--shard" ? args[1] : undefined;
  if (!shard || args.length > 3 || (args[2] !== undefined && args[2] !== "--list")) throw new Error("Usage: bun scripts/fork-unit-shard.ts --shard k/n [--list]");
  const selected = unitShard(selectUnitFiles(), shard);
  if (args[2] === "--list") console.log(JSON.stringify(selected));
  else {
    if (!selected.length) throw new Error(`No unit files in shard ${shard}`);
    process.exit(await run(selected));
  }
}
