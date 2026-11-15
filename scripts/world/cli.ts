/**
 * The test world's one command.
 *   bun scripts/world/cli.ts up [options]                starts a world, prints its description (one JSON line), stays
 *                                                        in the foreground as its owner and removes it when it ends
 *   bun scripts/world/cli.ts run [options] -- <command>  up, runs the command (OVIS_WORLD_FILE names the description),
 *                                                        always removes the world, exits with the command's code
 *   bun scripts/world/cli.ts down --name <world>         removes a world (idempotent)
 *   bun scripts/world/cli.ts add-machine --name <world> --machine m3:herdr   one more machine in a running world, with the
 *                                                        plan the world saved at its start, from inside the world's slot
 *   bun scripts/world/cli.ts ls | gc                     worlds and whether their owner lives | remove what dead owners left
 *   bun scripts/world/cli.ts services up|status|down     M2's long-lived test services (services.ts)
 *   bun scripts/world/cli.ts systemd-image               builds ovis-world-systemd:local (inside a slot)
 * up, run and add-machine run only inside a heavy slot (~/.ovis-toolchain/heavy-run.sh [-t SECONDS] -- <command>):
 * every container is pinned to the slot's band (OVIS_HEAVY_CPUS) and the world ends with the slot (OVIS_HEAVY_DEADLINE)
 * at the latest. down, ls, gc and describe work anywhere: they start no working container. services up|status|down
 * work anywhere too, and on purpose never in a slot: the services live for days on CPUs 0-55 (services.ts).
 * Options of up and run: --machine <name>:<herdr|core>[:all|engine|bare] (repeatable) --name --repo --account fake|real
 * --account-repo --limits open|hosted --passes off|grace|enforce --cpus <only the slot's band> --memory 2g --ttl <s> --scratch-root
 * --outbound --herdr-bin <file> --hc-bin <file> --origin <account|relay|app|kit>=<url> (repeatable) --site <app|kit>=<folder>
 * --trust-ca --people <file> --user <machine>=<name> --hostname <machine>=<name> --mount <machine>=<host>:<path>
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { planFromArgs, PlanError } from "./plan.ts";
import { gc, listWorlds, removeWorld } from "./teardown.ts";
import { DEFAULT_SCRATCH_ROOT, TOOL_DIR, inSlot, savedWorld, startPlannedWorld, type World } from "./world.ts";
import { hostCpus } from "./docker.ts";
import { SYSTEMD_IMAGE } from "./stage.ts";
import { Machine } from "./machines.ts";
import { checkWorldName, machineSpec } from "./plan.ts";
import { servicesCommand } from "./services.ts";

const HC_DEFAULT = join(process.env["HOME"] ?? "", ".local/bin/herdr-core");
const defaults = { env: process.env, host: hostCpus(), standins: process.env["OVIS_STANDINS"] ?? join(process.env["HOME"] ?? "", ".local/state/ovis-test-services/standins"), repo: join(TOOL_DIR, "../.."), scratchRoot: process.env["OVIS_WORLD_SCRATCH"] ?? DEFAULT_SCRATCH_ROOT, hcBin: existsSync(HC_DEFAULT) ? HC_DEFAULT : null };
const roots = [...new Set([defaults.scratchRoot, DEFAULT_SCRATCH_ROOT])];

async function up(args: string[]): Promise<number> {
  const plan = planFromArgs(args, defaults);
  const swept = await gc(roots);
  if (swept.length > 0) console.error(`swept worlds of dead owners: ${swept.join(", ")}`);
  const world = await startPlannedWorld(plan);
  console.log(JSON.stringify(world.description));
  // the owner waits for a signal: its handlers (teardown.ts) remove the world, and so does the reaper if it is killed
  await new Promise<never>(() => {});
  return 0;
}

async function runCommand(args: string[]): Promise<number> {
  const split = args.indexOf("--");
  if (split < 0 || split === args.length - 1) throw new PlanError("run: give the command after --");
  const plan = planFromArgs(args.slice(0, split), defaults);
  await gc(roots);
  let world: World | null = null;
  try {
    world = await startPlannedWorld(plan);
    const file = join(world.description.scratch, "world.json");
    const child = Bun.spawn(args.slice(split + 1), { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, OVIS_WORLD_FILE: file, OVIS_WORLD: world.name } });
    return await child.exited;
  } finally {
    await world?.teardown();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command = "", ...rest] = argv;
  switch (command) {
    case "up": return up(rest);
    case "run": return runCommand(rest);
    case "down": {
      const { values } = parseArgs({ args: rest, options: { name: { type: "string" }, "scratch-root": { type: "string" } } });
      if (!values.name) throw new PlanError("down --name <world>");
      // M2's long-lived services carry the world label svc-<name>, a name checkWorldName refuses: down never reaches them
      checkWorldName(values.name);
      const scratch = join(values["scratch-root"] ?? defaults.scratchRoot, values.name);
      await removeWorld(values.name, existsSync(scratch) ? scratch : null);
      console.log(JSON.stringify({ down: values.name }));
      return 0;
    }
    case "add-machine": {
      const { values } = parseArgs({ args: rest, options: { name: { type: "string" }, machine: { type: "string" }, "scratch-root": { type: "string" } } });
      if (!values.name || !values.machine) throw new PlanError("add-machine --name <world> --machine <name>:<engine>");
      checkWorldName(values.name);
      // the plan the world saved at its start: its origins, passes, repo, CA trust, memory and band, never defaults
      const world = savedWorld(values.name, values["scratch-root"] ?? defaults.scratchRoot);
      const machine: Machine = await world.addMachine(machineSpec(values.machine));
      console.log(JSON.stringify(machine.description));
      return 0;
    }
    case "ls": {
      const now = Date.now() / 1000;
      for (const entry of await listWorlds(roots)) console.log(JSON.stringify({ ...entry, expired: !entry.service && entry.expires <= now }));
      return 0;
    }
    case "gc": console.log(JSON.stringify({ removed: await gc(roots) })); return 0;
    case "services": return servicesCommand(rest);
    case "systemd-image": {
      // a build: only inside a heavy slot, on its band
      const band = inSlot();
      const child = Bun.spawn(["docker", "build", `--cpuset-cpus=${band}`, "-t", SYSTEMD_IMAGE, "-f", join(TOOL_DIR, "systemd.Dockerfile"), TOOL_DIR], { stdio: ["ignore", "inherit", "inherit"] });
      return child.exited;
    }
    case "describe": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { "scratch-root": { type: "string" } } });
      if ((positionals[0] ?? "") === "") throw new PlanError("describe needs a world's name: bun scripts/world/cli.ts describe <world> (`cli.ts ls` lists the worlds)");
      const name = checkWorldName(positionals[0] ?? "");
      const file = join(values["scratch-root"] ?? defaults.scratchRoot, name, "world.json");
      if (!existsSync(file)) throw new PlanError(`no world ${name} here: ${file} does not exist (another --scratch-root, or bun scripts/world/cli.ts ls)`);
      console.log(readFileSync(file, "utf8"));
      return 0;
    }
    default:
      console.error("usage: bun scripts/world/cli.ts up|run|down|add-machine|ls|gc|describe|services (see the head of cli.ts)");
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof PlanError ? `refused: ${error.message}` : error);
  process.exitCode = error instanceof PlanError ? 2 : 1;
}
