import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { FAVICON_CANDIDATES, findProjectFavicon } from "./project-favicon.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-project-favicon-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function project(name: string, files: string[]): string {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  for (const file of files) {
    mkdirSync(join(folder, file, ".."), { recursive: true });
    writeFileSync(join(folder, file), "<svg/>");
  }
  return folder;
}

describe("a project's favicon", () => {
  it("is the best place that holds an image", async () => {
    const folder = project("site", ["public/favicon.ico", "assets/logo.png", "README.md"]);
    expect(await findProjectFavicon(folder)).toMatchObject({ path: join(folder, "public/favicon.ico"), name: "favicon.ico", kind: "image" });
    expect(await findProjectFavicon(`${folder}/`)).toMatchObject({ path: join(folder, "public/favicon.ico") });
  });

  it("falls back to an app icon, then a logo", async () => {
    const app = project("electron", ["build/icon.png", "logo.svg"]);
    expect((await findProjectFavicon(app))?.path).toBe(join(app, "build/icon.png"));
    const logo = project("library", [".github/logo.png"]);
    expect((await findProjectFavicon(logo))?.path).toBe(join(logo, ".github/logo.png"));
  });

  it("passes over a place that is not an image file", async () => {
    const folder = project("odd", ["favicon.svg/inner.txt", "favicon.png"]);
    expect((await findProjectFavicon(folder))?.path).toBe(join(folder, "favicon.png"));
  });

  it("is null for a folder without one, a missing folder and a relative one", async () => {
    expect(await findProjectFavicon(project("plain", ["index.ts"]))).toBeNull();
    expect(await findProjectFavicon(join(root, "absent"))).toBeNull();
    // a relative path has no pane folder to be relative to, as with /api/fs/stat and no pane: it
    // is never read against the server's own folder
    const near = project("relative", ["favicon.svg"]);
    expect(await findProjectFavicon(relative(process.cwd(), near))).toBeNull();
  });

  describe("in a monorepo", () => {
    /** A project folder with these files, each holding `text` or, without one, an icon. */
    function repo(name: string, files: Record<string, string | null>): string {
      const folder = project(name, []);
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(join(folder, file, ".."), { recursive: true });
        writeFileSync(join(folder, file), text ?? "<svg/>");
      }
      return folder;
    }
    const icon = async (folder: string) => (await findProjectFavicon(folder))?.path;

    it("keeps the root's own icon over a workspace's", async () => {
      const folder = repo("mono-root", { "package.json": '{"workspaces":["apps/*"]}', "public/favicon.ico": null, "apps/admin/app/icon.svg": null });
      expect(await icon(folder)).toBe(join(folder, "public/favicon.ico"));
    });

    it("finds an icon in npm workspaces, listed or under packages", async () => {
      const listed = repo("mono-npm", { "package.json": '{"workspaces":["apps/*"]}', "apps/admin/app/icon.svg": null });
      expect(await icon(listed)).toBe(join(listed, "apps/admin/app/icon.svg"));
      const nested = repo("mono-object", { "package.json": '{"workspaces":{"packages":["packages/*"],"nohoist":["**/x"]}}', "packages/ui/logo.svg": null });
      expect(await icon(nested)).toBe(join(nested, "packages/ui/logo.svg"));
    });

    it("finds an icon in pnpm workspaces", async () => {
      const folder = repo("mono-pnpm", { "pnpm-workspace.yaml": "packages:\n  - 'web/*'\n  - '!web/old'\n", "web/old/favicon.svg": null, "web/site/public/favicon.png": null });
      expect(await icon(folder)).toBe(join(folder, "web/site/public/favicon.png"));
    });

    it("asks the workspaces in the order they are declared", async () => {
      const folder = repo("mono-order", { "package.json": '{"workspaces":["sites/*","apps/*"]}', "apps/admin/favicon.svg": null, "sites/b/icon.png": null, "sites/c/favicon.svg": null });
      expect(await icon(folder)).toBe(join(folder, "sites/b/icon.png"));
    });

    it("finds none, without throwing, in a broken manifest or a workspace outside the project", async () => {
      expect(await findProjectFavicon(repo("mono-broken", { "package.json": '{"workspaces": [', "pnpm-workspace.yaml": "packages: [", "apps/admin/app/icon.svg": null }))).toBeNull();
      repo("mono-outside/elsewhere", { "favicon.svg": null });
      const inner = repo("mono-outside/project", { "package.json": '{"workspaces":["../elsewhere","/tmp"]}' });
      symlinkSync(join(inner, "../elsewhere"), join(inner, "linked"));
      writeFileSync(join(inner, "pnpm-workspace.yaml"), "packages: [linked]\n");
      expect(await findProjectFavicon(inner)).toBeNull();
    });
  });

  it("lists the places best first: a favicon before an app icon before a logo", () => {
    const at = (candidate: (typeof FAVICON_CANDIDATES)[number]) => FAVICON_CANDIDATES.indexOf(candidate);
    expect(at("favicon.svg")).toBe(0);
    expect(at("public/favicon.ico")).toBeLessThan(at("app/icon.svg"));
    expect(at("build/icon.png")).toBeLessThan(at("logo.svg"));
    expect(new Set(FAVICON_CANDIDATES).size).toBe(FAVICON_CANDIDATES.length);
  });
});
