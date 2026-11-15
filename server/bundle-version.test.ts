import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newerBundleRelease, runtimeBundleVersion, sourceBundleVersion } from "./bundle-version.ts";
import { REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ovis-source-version-")); roots.push(root);
  const put = (path: string, content: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), content); };
  put("package.json", '{"version":"1.0.0","dependencies":{"example":"1"}}');
  put(".github/workflows/remote-bundles.yml", "bun-version: 1.4.2");
  put("server/index.ts", "export const value = 1;");
  return { root, put };
}

it("changes with bundle inputs, additions, removals, dependency pins and upstream versions", () => {
  const { root, put } = fixture();
  const first = sourceBundleVersion(root, "42");
  expect(sourceBundleVersion(root, "42")).toBe(first);
  put("server/index.ts", "export const value = 2;");
  expect(sourceBundleVersion(root, "42")).not.toBe(first);
  put("server/index.ts", "export const value = 1;");
  put("integrations/new.ts", "new");
  expect(sourceBundleVersion(root, "42")).not.toBe(first);
  rmSync(join(root, "integrations/new.ts"));
  expect(sourceBundleVersion(root, "42")).toBe(first);
  put("package.json", '{"version":"1.0.1","dependencies":{"example":"2"}}');
  expect(sourceBundleVersion(root, "42")).not.toBe(first);
  expect(sourceBundleVersion(root, "43")).not.toBe(sourceBundleVersion(root, "42"));
});

it("ignores UI, tests, docs, fixtures, app release numbers and generated Rust targets", () => {
  const { root, put } = fixture();
  const first = sourceBundleVersion(root);
  for (const path of ["src/App.tsx", "server/AGENTS.md", "server/a.test.ts", "server/fixtures/a.json", "crates/pty-sidecar/target/debug/bin"]) put(path, "ignored");
  put("package.json", '{"version":"9.0.0","dependencies":{"example":"1"}}');
  expect(sourceBundleVersion(root)).toBe(first);
});

it("ignores generated build output: dist directories and tsbuildinfo files", () => {
  const { root, put } = fixture();
  put("shared/vendor/x/src/a.ts", "export {};");
  const first = sourceBundleVersion(root);
  for (const path of ["shared/vendor/x/dist/a.d.ts", "shared/vendor/x/dist/a.d.ts.map", "shared/vendor/x/tsconfig.tsbuildinfo", "shared/vendor/x/dist/tsconfig.tsbuildinfo"]) put(path, "generated");
  expect(sourceBundleVersion(root)).toBe(first);
  put("shared/vendor/x/src/a.ts", "export const changed = 1;");
  expect(sourceBundleVersion(root)).not.toBe(first);
});

it("starts from minimal source copies without CI configuration and still hashes pins when present", () => {
  const { root, put } = fixture();
  const pinned = sourceBundleVersion(root);
  rmSync(join(root, ".github"), { recursive: true });
  const minimal = runtimeBundleVersion(root);
  expect(minimal).not.toBe(pinned);
  expect(runtimeBundleVersion(root)).toBe(minimal);
  put(".github/workflows/remote-bundles.yml", "bun-version: 1.4.2");
  expect(runtimeBundleVersion(root)).toBe(pinned);
});

it("carries the source identity into a bundle without needing source-only files", () => {
  const { root, put } = fixture();
  const revision = sourceBundleVersion(root);
  put("bundle.json", JSON.stringify({ version: REMOTE_BUNDLE_VERSION, revision }));
  rmSync(join(root, ".github"), { recursive: true });
  expect(runtimeBundleVersion(root)).toBe(revision);
  put("bundle.json", '{"revision":"not-a-version"}');
  expect(() => runtimeBundleVersion(root)).toThrow("Invalid runtime bundle version");
});

it("never replaces a bridge from a newer upstream compatibility release", () => {
  const next = String(Number(REMOTE_BUNDLE_VERSION) + 1);
  expect(newerBundleRelease(next)).toBe(true);
  expect(newerBundleRelease(`${next}+${"a".repeat(24)}`)).toBe(true);
  expect(newerBundleRelease(`${REMOTE_BUNDLE_VERSION}+${"b".repeat(24)}`)).toBe(false);
  expect(newerBundleRelease("unknown")).toBe(false);
});
