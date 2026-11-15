/**
 * What the open tree, the import into the public repository, must not carry. `scripts/world/measured/` was the
 * place for a recorded look of a real machine: such a record stays out of this repository, so the import's checks
 * fail while the folder is there.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repo } from "./source-scan.ts";

test("a recorded look of a real machine stays out of this repository (scripts/world/measured/)", () => {
  expect(existsSync(join(repo, "scripts/world/measured")), "scripts/world/measured/ stays out of the public repository: remove it").toBe(false);
});
