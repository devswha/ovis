/** The product engines share one recorded runtime identity, independent of engine lifetimes. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateState } from "../private-state.ts";
import { savedServerId } from "../relay/identity.ts";
import { defaultStateDir } from "../update-state.ts";

export function runtimeIdentity(fleetState: string) {
  // Freeze both the PC id and its source on the first start; later service environments cannot change it.
  const path = join(fleetState, "runtime-id.json");
  let identity: { v: 1; runtime_id: string; source: { kind: "own-ovis"; state_dir: string } | { kind: "minted" } };
  try {
    identity = JSON.parse(readFileSync(path, "utf8")) as typeof identity;
    if (identity?.v !== 1 || typeof identity.runtime_id !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(identity.runtime_id)
      || !identity.source || (identity.source.kind !== "minted" && !(identity.source.kind === "own-ovis" && typeof identity.source.state_dir === "string"))) {
      throw new Error("Invalid fleet runtime-id.json");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const ownState = defaultStateDir();
    const ownId = savedServerId(ownState);
    identity = { v: 1, runtime_id: ownId ?? randomUUID(), source: ownId ? { kind: "own-ovis", state_dir: ownState } : { kind: "minted" } };
    writePrivateState(path, identity);
  }
  return identity;
}
