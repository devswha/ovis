/**
 * Lists every package bundled into the binaries of a folder, with its licence, and fails on one we may
 * not ship:
 *
 *   bun scripts/licence-check.ts <dir>
 *
 * It reads each `<binary>.meta.json` in <dir> (written by the binary's build: the source files
 * bundled into that binary) and finds the package of every file under node_modules. A package fails
 * when its licence is not on the allowed list (MIT, Apache-2.0, BSD, ISC, MPL-2.0, Unicode, Zlib; an
 * "OR" needs one allowed side, an "AND" both) or when THIRD_PARTY_NOTICES.md does not name it as
 * `name`. Exit 0 when all pass, 1 naming each failure, 2 on a usage error or a folder with no meta file.
 * This repository's own files, and what it vendors outside node_modules, are no package.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const META_SUFFIX = ".meta.json";

const ALLOWED = [/^MIT$/, /^Apache-2\.0$/, /^(0BSD|BSD-[23]-Clause(-Clear)?|BSD)$/, /^ISC$/, /^MPL-2\.0$/, /^Unicode-(DFS-2015|DFS-2016|3\.0)$/, /^Zlib$/];

export interface BundledPackage { binary: string; name: string; version: string; licence: string | null }

/** Whether an SPDX expression (no parentheses beyond an outer pair) allows shipping. */
export function licenceAllowed(expression: string): boolean {
  const text = expression.trim().replace(/^\((.*)\)$/, "$1").trim();
  if (/\s+OR\s+/.test(text)) return text.split(/\s+OR\s+/).some(licenceAllowed);
  if (/\s+AND\s+/.test(text)) return text.split(/\s+AND\s+/).every(licenceAllowed);
  return ALLOWED.some((pattern) => pattern.test(text));
}

/** The package root of a bundled file under node_modules (the innermost one), or null. */
function packageRoot(file: string): string | null {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return null;
  const length = parts[at + 1]!.startsWith("@") ? 2 : 1;
  return parts.slice(0, at + 1 + length).join(sep);
}

function licenceOf(manifest: { license?: unknown; licenses?: unknown }): string | null {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license !== null && typeof manifest.license === "object" && typeof (manifest.license as { type?: unknown }).type === "string") return (manifest.license as { type: string }).type;
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses.map((entry: { type?: unknown }) => entry?.type).filter((type): type is string => typeof type === "string");
    return types.length > 0 ? types.join(" OR ") : null;
  }
  return null;
}

/** Every package each binary of `dir` holds; `root` is where the meta files' paths start. */
export function bundledPackages(dir: string, root = ROOT): BundledPackage[] {
  const metas = readdirSync(dir).filter((name) => name.endsWith(META_SUFFIX)).sort();
  if (metas.length === 0) throw new Error(`${dir} holds no *${META_SUFFIX}: build the binaries there first`);
  const found: BundledPackage[] = [];
  for (const meta of metas) {
    const { binary, inputs } = JSON.parse(readFileSync(join(dir, meta), "utf8")) as { binary: string; inputs: string[] };
    const roots = new Set(inputs.map(packageRoot).filter((path): path is string => path !== null));
    for (const path of [...roots].sort()) {
      const manifest = JSON.parse(readFileSync(resolve(root, path, "package.json"), "utf8")) as { name?: string; version?: string; license?: unknown; licenses?: unknown };
      found.push({ binary, name: manifest.name ?? path, version: manifest.version ?? "?", licence: licenceOf(manifest) });
    }
  }
  return found;
}

/** Why each package may not ship, one line each; empty when all may. */
export function licenceProblems(packages: readonly BundledPackage[], notices: string): string[] {
  return packages.flatMap((entry) => [
    ...entry.licence === null ? [`${entry.binary}: ${entry.name} ${entry.version} names no licence`]
      : licenceAllowed(entry.licence) ? [] : [`${entry.binary}: ${entry.name} ${entry.version} is ${entry.licence}, which is not on the allowed list`],
    ...notices.includes(`\`${entry.name}\``) ? [] : [`${entry.binary}: ${entry.name} ${entry.version} is missing from THIRD_PARTY_NOTICES.md`],
  ]);
}

if (import.meta.main) {
  const [dir, ...rest] = process.argv.slice(2);
  if (dir === undefined || rest.length > 0 || !existsSync(dir)) {
    console.error("usage: bun scripts/licence-check.ts <dir>");
    process.exit(2);
  }
  let packages: BundledPackage[];
  try {
    packages = bundledPackages(resolve(dir));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  for (const entry of packages) console.log(`${entry.binary}\t${entry.name}\t${entry.version}\t${entry.licence ?? "(none)"}`);
  const problems = licenceProblems(packages, readFileSync(join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8"));
  for (const problem of problems) console.error(problem);
  process.exit(problems.length > 0 ? 1 : 0);
}
