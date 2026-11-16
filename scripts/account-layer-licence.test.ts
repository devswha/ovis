/**
 * The account layer's licence marks (LICENSES/ACCOUNT-LAYER.md): every file under `shared/account-list*` starts with
 * `// SPDX-License-Identifier: FSL-1.1-MIT`, or is covered by an annotation of that licence in REUSE.toml (the JSON test
 * vectors, which hold no comment). The glob is read on every run, hidden files and folders too, so a file added there
 * later is born under the licence or fails here.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, repo } from "./source-scan.ts";

const LICENCE = "FSL-1.1-MIT";
const LINE = `// SPDX-License-Identifier: ${LICENCE}`;

interface Annotation { path: string | string[]; "SPDX-License-Identifier"?: string }

test("every file of the account layer carries its SPDX line or is covered by REUSE.toml", () => {
  const reuse = Bun.TOML.parse(readFileSync(join(repo, "REUSE.toml"), "utf8")) as { annotations?: Annotation[] };
  const annotated = (reuse.annotations ?? []).filter((annotation) => annotation["SPDX-License-Identifier"] === LICENCE)
    .flatMap((annotation) => [annotation.path].flat().map((path) => new Bun.Glob(path)));
  const layer = [...new Set([...new Bun.Glob("shared/account-list*").scanSync({ cwd: repo, dot: true }), ...new Bun.Glob("shared/account-list*/**").scanSync({ cwd: repo, dot: true })])].sort();
  expect(layer.length).toBeGreaterThan(0);
  const unmarked = layer.filter((file) => readFileSync(join(repo, file), "utf8").split("\n", 1)[0] !== LINE && !annotated.some((glob) => glob.match(file)));
  fail(unmarked, `Start each file under shared/account-list* with "${LINE}", or cover it in REUSE.toml with SPDX-License-Identifier = "${LICENCE}" (LICENSES/ACCOUNT-LAYER.md):`);
});
