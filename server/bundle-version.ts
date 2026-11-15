/** Fork runtime identity. Upstream keeps its numeric release version; source installs also identify the code they ship. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { REMOTE_BUNDLE_VERSION as RELEASE_VERSION } from "../shared/machines.ts";

// Shared with the release guards so adding an input cannot silently leave automatic updates behind.
export const BUNDLE_PATHSPECS = ["server", "shared", "integrations", "patches", "bun.lock", "scripts/build-remote-bundle.ts", "scripts/server-artifact.ts", "scripts/install-gjc-integration.ts", "scripts/install-pi-integration.ts", "scripts/pty-sidecar.ts", "crates/pty-sidecar"];
// Generated output (`tsc -b` writes shared/vendor/*/dist and *.tsbuildinfo, gitignored) differs between checkouts of the same commit, so it must not enter the identity.
export const bundleInput = (path: string): boolean => BUNDLE_PATHSPECS.some((spec) => path === spec || path.startsWith(`${spec}/`))
  && !path.endsWith(".test.ts") && !path.endsWith(".md") && !path.startsWith("server/fixtures/")
  && !path.split("/").some((part) => ["target", "node_modules", ".git", "dist"].includes(part)) && !path.endsWith(".tsbuildinfo");
export const BUNDLE_WORKFLOW = ".github/workflows/remote-bundles.yml";
export const bunPins = (workflow: string): string => [...workflow.matchAll(/bun-version:\s*(\S+)/g)].map((match) => match[1]).join(" ");
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "patchedDependencies", "overrides", "trustedDependencies"];
export const dependencies = (packageJson: string): string => {
  const parsed = JSON.parse(packageJson) as Record<string, unknown>;
  return JSON.stringify(DEPENDENCY_FIELDS.map((field) => parsed[field] ?? null));
};

/** Paths and bytes, not git history, mtimes, a release's app version or the builder's OS. */
export function sourceBundleVersion(root: string, release = RELEASE_VERSION): string {
  const hash = createHash("sha256");
  const add = (path: string, bytes: Uint8Array | string): void => {
    const content = Buffer.from(bytes);
    hash.update(`${path}\0${content.length}\0`).update(content);
  };
  const visit = (path: string): void => {
    if (!bundleInput(path)) return;
    const full = join(root, path);
    let stat;
    try { stat = lstatSync(full); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (stat.isDirectory()) for (const name of readdirSync(full).sort()) visit(`${path}/${name}`);
    else if (stat.isSymbolicLink()) add(path, readlinkSync(full));
    else if (stat.isFile()) add(path, readFileSync(full));
  };
  for (const path of [...BUNDLE_PATHSPECS].sort()) visit(path);
  add("package.json", dependencies(readFileSync(join(root, "package.json"), "utf8")));
  // Minimal source copies need not ship CI configuration; hash pins when it is present.
  let workflow = "";
  try { workflow = readFileSync(join(root, BUNDLE_WORKFLOW), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  add(BUNDLE_WORKFLOW, bunPins(workflow));
  return `${release}+${hash.digest("hex").slice(0, 24)}`;
}

/** Bundles carry the source identity, since build scripts, lockfiles and workflow are not shipped. */
export function runtimeBundleVersion(root: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "bundle.json"), "utf8")) as { version?: unknown; revision?: unknown };
    if (typeof manifest.revision !== "string" || !/^\d+\+[a-f0-9]{24}$/.test(manifest.revision) || manifest.revision.split("+")[0] !== manifest.version) throw new Error("Invalid runtime bundle version");
    return manifest.revision;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return sourceBundleVersion(root);
}

// Freeze identity at process start: changing a checkout cannot relabel an already-running bridge.
declare const OVIS_BUNDLE_REVISION: string | undefined;
export const REMOTE_BUNDLE_VERSION = typeof OVIS_BUNDLE_REVISION === "string"
  ? OVIS_BUNDLE_REVISION : runtimeBundleVersion(resolve(import.meta.dir, ".."));

/** Preserve upstream's refusal to replace a bridge from a newer compatibility release. */
export function newerBundleRelease(version: unknown): boolean {
  if (typeof version !== "string" || !/^\d+(?:\+[a-f0-9]{24})?$/.test(version)) return false;
  return Number(version.split("+")[0]) > Number(RELEASE_VERSION);
}
