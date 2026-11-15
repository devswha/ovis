/**
 * A world's reaper: started by the owner under setsid, it is the one that finishes the world. It waits while the
 * owner lives, the world's deadline is ahead and the scratch folder is there; then it removes the world, again and
 * again until nothing is left, and ends. Nobody ends it before that: the owner, `down` and gc end it only as the last
 * step of a removal, having seen nothing left (teardown.ts, removeWorld). So an owner killed anywhere, also in the
 * middle of its own teardown, leaves the rest to it. It removes only its owner's objects (a world of the same name
 * started from another scratch root is not its), and it ends only when no docker call naming the world still runs:
 * an owner stopped during its start leaves its call in flight, and what that call makes lands afterwards.
 * Usage: bun reaper.ts <world> <owner pid:start> <deadline epoch s> <scratch>
 */
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive, dockerInFlight, processIdentity } from "./docker.ts";
import { removeWorld } from "./teardown.ts";

const [name = "", owner = "", deadlineText = "", scratch = ""] = process.argv.slice(2);
const deadline = Number(deadlineText) * 1000;
if (name === "" || owner === "" || !Number.isFinite(deadline) || scratch === "") throw new Error("usage: bun reaper.ts <world> <owner> <deadline> <scratch>");
const say = (event: string) => console.log(JSON.stringify({ at: new Date().toISOString(), event, world: name }));
try { writeFileSync(join(scratch, "reaper.pid"), String(processIdentity(process.pid))); } catch (error) { say(`no reaper.pid: ${(error as Error).message}`); }
say("watching");

/** Only "no such folder" counts: any other answer about the folder is no reason to take a world away. */
const scratchGone = () => { try { statSync(scratch); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; } };
// Waiting asks docker nothing. The scratch folder goes last in every removal, so its absence says that a removal
// reached its end: whatever that one could not take (nothing, by its own check) is the reaper's too.
let reason = "deadline";
while (Date.now() < deadline) {
  if (!alive(owner)) { reason = "owner gone"; break; }
  if (scratchGone()) { reason = "scratch folder gone"; break; }
  await Bun.sleep(250);
}
say(reason);

// The waiting ended at the deadline at the latest, so there is a minute or more to finish: the reaper never outlives
// the world it watches by more than that. A removal that leaves something is no reason to end: another remover may be
// at work this moment (the dead owner's own call still running at docker, a gc), so it looks and removes again.
let removed = false;
let last = "";
for (const end = deadline + 60_000; !removed && Date.now() < end;) {
  try {
    // looked at BEFORE the removal: a call that ends during it may have made something this removal did not see
    const flying = await dockerInFlight(name, owner);
    await removeWorld(name, scratch, owner, say);
    if (flying.length === 0) { removed = true; break; }
    const message = `waiting for docker calls in flight: ${flying.map((line) => line.slice(0, 160)).join(" | ")}`;
    if (message !== last) say(message);
    last = message;
    await Bun.sleep(500);
  } catch (error) {
    const message = (error as Error).message;
    if (message !== last) say(`not removed yet: ${message}`);
    last = message;
    await Bun.sleep(500);
  }
}
say(removed ? "removed" : "gave up a minute after the deadline: gc removes the rest");
process.exitCode = removed ? 0 : 1;
