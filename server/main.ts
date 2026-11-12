/**
 * The compiled binary's one entry (scripts/build-server.ts): `ovis-server <entry> [arguments]` runs the
 * entry server/entries.ts names, with the arguments where that entry reads them when run from source.
 */
import { ENTRIES, type EntryName } from "./entries.ts";

const name = process.argv[2];
if (name === undefined || !Object.hasOwn(ENTRIES, name)) {
  console.error(`usage: ovis-server <${Object.keys(ENTRIES).join("|")}> [arguments]`);
  process.exit(2);
}
process.argv.splice(2, 1);
await ENTRIES[name as EntryName].run();
