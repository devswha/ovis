import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledPackages, licenceAllowed, licenceProblems } from "./licence-check.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A checkout with these packages installed and a folder whose one binary bundles a file of each. */
function fixture(packages: Record<string, object>): { root: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), "licence-check-"));
  dirs.push(root);
  const inputs = ["server/index.ts", "shared/vendor/paseo-e2ee/e2ee.ts"];
  for (const [name, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, "node_modules", name, "lib"), { recursive: true });
    writeFileSync(join(root, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
    inputs.push(`node_modules/${name}/lib/index.js`, `node_modules/${name}/lib/other.js`);
  }
  const out = join(root, "out");
  mkdirSync(out);
  writeFileSync(join(out, "ovis-agent.meta.json"), JSON.stringify({ binary: "ovis-agent", inputs }));
  return { root, out };
}

describe("licence-check", () => {
  test("lists each bundled package once with its licence, and nothing of this repository", () => {
    const { root, out } = fixture({ "jsonc-parser": { license: "MIT" }, "@scope/pkg": { license: "(MIT OR GPL-3.0)" } });
    expect(bundledPackages(out, root)).toEqual([
      { binary: "ovis-agent", name: "@scope/pkg", version: "1.0.0", licence: "(MIT OR GPL-3.0)" },
      { binary: "ovis-agent", name: "jsonc-parser", version: "1.0.0", licence: "MIT" },
    ]);
  });

  test("passes allowed licences named in the notices", () => {
    const { root, out } = fixture({ "jsonc-parser": { license: "MIT" }, "@scope/pkg": { license: "Apache-2.0" } });
    expect(licenceProblems(bundledPackages(out, root), "- `jsonc-parser` 3.3.1\n- `@scope/pkg`\n")).toEqual([]);
  });

  test("fails a package the notices do not name", () => {
    const { root, out } = fixture({ "left-pad": { license: "MIT" } });
    expect(licenceProblems(bundledPackages(out, root), "- `jsonc-parser`\n")).toEqual(["ovis-agent: left-pad 1.0.0 is missing from THIRD_PARTY_NOTICES.md"]);
  });

  test("fails a licence off the list, and one that names none", () => {
    const { root, out } = fixture({ copyleft: { license: "GPL-3.0-only" }, bare: {} });
    expect(licenceProblems(bundledPackages(out, root), "`copyleft` `bare`")).toEqual([
      "ovis-agent: bare 1.0.0 names no licence",
      "ovis-agent: copyleft 1.0.0 is GPL-3.0-only, which is not on the allowed list",
    ]);
  });

  test("reads SPDX OR and AND", () => {
    expect(licenceAllowed("(MIT OR Apache-2.0)")).toBe(true);
    expect(licenceAllowed("GPL-2.0 OR MIT")).toBe(true);
    expect(licenceAllowed("MIT AND GPL-2.0")).toBe(false);
    expect(["BSD-3-Clause", "BSD-2-Clause", "0BSD", "ISC", "MPL-2.0", "Unicode-3.0", "Zlib"].every(licenceAllowed)).toBe(true);
    expect(licenceAllowed("SSPL-1.0")).toBe(false);
  });

  test("the command exits 1 naming the failure, and 2 on a folder with no binary", async () => {
    const bad = fixture({ copyleft: { license: "GPL-3.0-only" } });
    const empty = mkdtempSync(join(tmpdir(), "licence-check-empty-"));
    dirs.push(empty);
    const script = join(import.meta.dir, "licence-check.ts");
    const run = Bun.spawn([process.execPath, script, empty], { stderr: "pipe" });
    expect(await run.exited).toBe(2);
    // the command resolves relative paths in this checkout; an absolute one reaches the fixture's package
    writeFileSync(join(bad.out, "ovis-agent.meta.json"), JSON.stringify({ binary: "ovis-agent", inputs: [join(bad.root, "node_modules/copyleft/lib/index.js")] }));
    const failing = Bun.spawn([process.execPath, script, bad.out], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([failing.exited, new Response(failing.stdout).text(), new Response(failing.stderr).text()]);
    expect(code).toBe(1);
    expect(stdout).toBe("ovis-agent\tcopyleft\t1.0.0\tGPL-3.0-only\n");
    expect(stderr).toContain("copyleft 1.0.0 is GPL-3.0-only, which is not on the allowed list");
  });
});
