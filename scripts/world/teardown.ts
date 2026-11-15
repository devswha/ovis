/**
 * The layers that remove a world when its owner does not: (1) the owner's own handlers (signals and a normal end), (2) a reaper in a
 * session of its own that removes the world once the owner is gone, (4) `gc`, and every start, sweep what dead owners
 * left. Layer (3), docker's own deadline on every container, is in docker.ts (underDeadline). All of them remove
 * through removeWorld, which ends the reaper last: a remover killed part-way leaves a world that still has it.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { alive, containers, containerWorlds, dockerInFlight, networks, processIdentity, removeObjects, run, worldLabels } from "./docker.ts";
import { LABEL } from "./plan.ts";

interface Owned { readonly name: string; teardown(): Promise<void> }
const owned = new Set<Owned>();
const SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
let installed = false;

export function teardownOnSignals(world: Owned): void {
  owned.add(world);
  if (installed) return;
  installed = true;
  for (const [signal, code] of Object.entries(SIGNALS)) {
    process.on(signal, () => {
      void Promise.allSettled([...owned].map((entry) => entry.teardown())).then((results) => { said(results, signal); process.exit(code); });
    });
  }
  // a normal end (nothing left to run: a script that never disposed its world) removes it too; the loop then runs dry
  // again with nobody owned and the process ends. process.exit() and KILL skip this: the reaper finishes those.
  process.on("beforeExit", () => {
    if (owned.size === 0) return;
    const entries = [...owned];
    owned.clear();
    void Promise.allSettled(entries.map((entry) => entry.teardown())).then((results) => said(results, "the end of the process"));
  });
}

/** A teardown that failed is said (the reaper finishes it), never swallowed. */
function said(results: readonly PromiseSettledResult<unknown>[], on: string): void {
  for (const result of results) if (result.status === "rejected") console.error(`world teardown on ${on} failed, its reaper finishes it: ${(result.reason as Error).message ?? result.reason}`);
}

export function forgetOnSignals(world: Owned): void { owned.delete(world); }

/**
 * Removes a world's scratch folder only when it is one: its last name is the world's and it holds the owner.json this
 * tool wrote there for that world. The path may come from a docker label, which is data from outside: anything else
 * is kept and said. owner.json goes last, so a remover killed part-way leaves a folder the next one still knows; the
 * one state after that, the folder empty under the world's name, goes too (an empty folder holds nothing of anyone's).
 * Returns whether it was removed (true also when it is gone already).
 */
export function removeScratch(world: string, scratch: string, say: (line: string) => void = (line) => console.error(line)): boolean {
  const read = <T>(what: () => T): T | null => { try { return what(); } catch { return null; } };
  // the marker is read before the entries: a remover at work beside this one takes the entries first and the marker
  // last, so a marker found gone is never followed by entries still there
  const marker = read(() => (JSON.parse(readFileSync(join(scratch, "owner.json"), "utf8")) as { name?: unknown }).name);
  const entries = read(() => readdirSync(scratch));
  if (!existsSync(scratch)) return true;
  if (basename(scratch) !== world || entries === null || (marker !== world && entries.length > 0)) {
    say(`kept ${scratch}: not the scratch folder of world ${world} (no owner.json of it there)`);
    return false;
  }
  for (const entry of entries) if (entry !== "owner.json") rmSync(join(scratch, entry), { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  return true;
}

export interface ReaperArgs { readonly name: string; readonly owner: string; readonly expires: number; readonly scratch: string }

/**
 * Starts reaper.ts under setsid (its own session and process group), so a signal to the owner's group never reaches it,
 * and returns once it is watching (its reaper.pid names a live process): a world never starts without its finisher.
 */
export async function startReaper(args: ReaperArgs, within = 15_000): Promise<void> {
  const child = Bun.spawn(["setsid", "bun", join(import.meta.dir, "reaper.ts"), args.name, args.owner, String(args.expires), args.scratch], {
    stdin: "ignore", stdout: Bun.file(join(args.scratch, "reaper.log")), stderr: Bun.file(join(args.scratch, "reaper.err")),
  });
  child.unref();
  for (const end = Date.now() + within; Date.now() < end; await Bun.sleep(50)) {
    const reaper = reaperOf(args.scratch);
    if (reaper !== null && alive(reaper)) return;
  }
  const err = (() => { try { return readFileSync(join(args.scratch, "reaper.err"), "utf8").trim().slice(-300); } catch { return ""; } })();
  throw new Error(`the reaper of world ${args.name} did not start within ${within} ms${err ? `: ${err}` : ""}`);
}

/** A world's reaper as its reaper.pid names it (`<pid>:<start>`, so a reused pid is never taken for it), or null. */
const reaperOf = (scratch: string): string | null => { try { return readFileSync(join(scratch, "reaper.pid"), "utf8").trim(); } catch { return null; } };

/**
 * Removes a world: its containers and networks, then its scratch folder, and only then, with nothing left, ends its
 * reaper. The owner's teardown, `down`, gc and the reaper itself all remove this way. Until that last step the reaper
 * lives, so a remover killed anywhere on the way leaves a world that still has its finisher, and the reaper is ended
 * only by one who has just seen that nothing is left, and no docker call naming the world still runs (a start cut short
 * leaves one in flight: what it makes is the reaper's). Throws when a container or network is left; a scratch folder
 * that is kept (removeScratch says why) leaves the reaper alone. With an owner (`<pid>:<start>`), only that owner's
 * objects go: never another world's of the same name; `down` and a nameless sweep remove by name.
 */
export async function removeWorld(world: string, scratch: string | null, owner: string | null = null, say: (line: string) => void = (line) => console.error(line)): Promise<void> {
  const reaper = scratch === null ? null : reaperOf(scratch); // read first: reaper.pid goes with the folder
  const before = await dockerInFlight(world, owner); // a call that ends during the removal may make what it did not see
  await removeObjects(world, owner);
  if (scratch !== null && !removeScratch(world, scratch, say)) return;
  if (reaper === null || reaper === processIdentity(process.pid) || !alive(reaper)) return;
  const flying = [...before, ...await dockerInFlight(world, owner)];
  if (flying.length > 0) { say(`left the reaper of ${world} at work: docker calls naming it still run (${flying.length})`); return; }
  // a reaper that ended by itself this moment is no failure
  try { process.kill(Number(reaper.split(":")[0]), "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

export interface WorldEntry { readonly name: string; readonly owner: string; readonly ownerAlive: boolean; readonly expires: number; readonly scratch: string | null; readonly service: boolean }

/** Every world on this PC: from network labels, then containers whose network is gone, then scratch folders left alone. */
export async function listWorlds(scratchRoots: readonly string[]): Promise<WorldEntry[]> {
  const entries = new Map<string, WorldEntry>();
  for (const labels of await worldLabels()) {
    const name = labels[LABEL] ?? "";
    const owner = labels[`${LABEL}.owner`] ?? "";
    entries.set(name, { name, owner, ownerAlive: owner === "service" || alive(owner), expires: Number(labels[`${LABEL}.expires`] ?? 0), scratch: labels[`${LABEL}.scratch`] ?? null, service: owner === "service" });
  }
  for (const name of await containerWorlds()) if (!entries.has(name)) entries.set(name, { name, owner: "", ownerAlive: false, expires: 0, scratch: null, service: false });
  for (const left of scratchOwners(scratchRoots)) {
    if (!entries.has(left.name)) entries.set(left.name, { ...left, ownerAlive: alive(left.owner), service: false });
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The owner.json of every scratch folder under the roots. One that cannot be read (empty after a full disk, cut by a
 * kill during its write) is said and skipped: it never stops ls, gc or the next up, and removeScratch keeps its folder.
 */
export function scratchOwners(scratchRoots: readonly string[], say: (line: string) => void = (line) => console.error(line)): { name: string; owner: string; expires: number; scratch: string }[] {
  const found: { name: string; owner: string; expires: number; scratch: string }[] = [];
  for (const root of scratchRoots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const file = join(root, name, "owner.json");
      if (!existsSync(file)) continue;
      try {
        const left = JSON.parse(readFileSync(file, "utf8")) as { owner?: unknown; expires?: unknown };
        if (typeof left.owner !== "string" || typeof left.expires !== "number") throw new Error("no owner and expires in it");
        found.push({ name, owner: left.owner, expires: left.expires, scratch: join(root, name) });
      } catch (error) {
        say(`skipped ${file}: not an owner.json this tool can read (${(error as Error).message}); the folder is kept`);
      }
    }
  }
  return found;
}

/** What is left of a world: containers, networks, its scratch folder and any process of this tool naming it. Empty is clean. */
export async function leftovers(name: string, scratch: string): Promise<string[]> {
  const found = [...(await containers(name)).map((c) => `container ${c}`), ...(await networks(name)).map((n) => `network ${n}`)];
  if (existsSync(scratch)) found.push(`scratch ${scratch}`);
  // the world's name as a word of its own (a reaper's first argument, a cli's --name): w1 is not w1-m
  const procs = (await run(["pgrep", "-af", `scripts/world/(reaper\\.ts|cli\\.ts .*--name) ${name}( |$)`])).out.split("\n").filter(Boolean);
  return [...found, ...procs.map((line) => `process ${line}`)];
}

/** Removes every world whose owner is gone or whose deadline passed (never a service); returns their names. */
export async function gc(scratchRoots: readonly string[], now = Date.now() / 1000): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await listWorlds(scratchRoots)) {
    if (entry.service || (entry.ownerAlive && entry.expires > now)) continue;
    // a dead world's reaper may be removing it this moment: what is left for now is said, and is the reaper's or the next gc's
    try {
      // the owner it was seen with: a live world of the same name (another scratch root) is never taken with it
      await removeWorld(entry.name, entry.scratch, entry.owner === "" ? null : entry.owner);
      removed.push(entry.name);
    } catch (error) {
      console.error(`gc: ${(error as Error).message}`);
    }
  }
  return removed;
}
