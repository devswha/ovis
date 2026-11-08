import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRevision } from "./app-revision.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
/** an app folder whose dist/ holds a build.json naming that revision (or the given text), as vite writes it */
function app(build?: string): string {
  const root = mkdtempSync(join(tmpdir(), "ovis-app-"));
  roots.push(root);
  if (build !== undefined) { mkdirSync(join(root, "dist")); writeFileSync(join(root, "dist", "build.json"), build); }
  return root;
}
const A = "a".repeat(40), B = "b".repeat(40);

it("names the build's own revision where no supervisor sets OVIS_REVISION, as in the desktop app", () => {
  expect(buildRevision(app(JSON.stringify({ revision: B })), {})).toBe(B);
});

it("takes the release the supervisor runs first, and names none for a build that names none", () => {
  expect(buildRevision(app(JSON.stringify({ revision: B })), { OVIS_REVISION: A })).toBe(A);
  for (const build of [undefined, "", "not json", JSON.stringify({}), JSON.stringify({ revision: "abc" })]) expect(buildRevision(app(build), {})).toBeUndefined();
  // an OVIS_REVISION out of shape is no revision either
  expect(buildRevision(app(), { OVIS_REVISION: "main" })).toBeUndefined();
});
