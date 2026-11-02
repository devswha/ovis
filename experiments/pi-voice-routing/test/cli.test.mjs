import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(entry, args) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", input: "" });
}

test("a bad argument prints the usage line and exits 1", () => {
  const result = run(join(root, "src/main.mjs"), ["--bogus"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node src\/main\.mjs --fake\|--local/);
});

test("a symlinked launch still runs the CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-routing-link-"));
  try {
    const link = join(dir, "experiment");
    symlinkSync(root, link, "dir");
    const result = run(join(link, "src/main.mjs"), ["--bogus"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
