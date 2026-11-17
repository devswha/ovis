import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleNotes, noteFileName, notePath } from "./notes.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const folder = () => { const root = mkdtempSync(join(tmpdir(), "ovis-notes-")); roots.push(root); return root; };
const call = (root: string, method: string, path: string, body?: unknown, readOnly = false) => {
  const url = new URL(`http://x${path}`);
  return handleNotes(new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) }), url, readOnly, root);
};

test("a note's path stays a Markdown file inside the folder", () => {
  const root = "/home/me/Notes";
  expect(notePath(root, "Todo.md")).toBe("/home/me/Notes/Todo.md");
  expect(notePath(root, "banx-app/Release list.md")).toBe("/home/me/Notes/banx-app/Release list.md");
  for (const bad of ["../x.md", "a/../../x.md", "/etc/x.md", ".hidden.md", "a/.git/x.md", "x.txt", "a//x.md", "", 3]) expect(notePath(root, bad)).toBeNull();
  expect(noteFileName(" Plan: v1 / later ")).toBe("Plan v1 later.md");
  expect(noteFileName("  ")).toBeNull();
});

test("notes are listed newest first, made, saved, renamed and deleted", async () => {
  const root = folder();
  mkdirSync(join(root, "banx-app"));
  writeFileSync(join(root, "banx-app", "Release.md"), "- [ ] ship");
  writeFileSync(join(root, ".hidden.md"), "no");
  const made = await (await call(root, "POST", "/api/fork/notes")).json() as { path: string };
  expect(made.path).toBe("Untitled.md");
  expect((await (await call(root, "POST", "/api/fork/notes")).json() as { path: string }).path).toBe("Untitled 2.md");
  const saved = await call(root, "PUT", "/api/fork/notes/file?path=Untitled.md", { text: "# Hi\n" });
  expect(saved.status).toBe(200);
  expect(readFileSync(join(root, "Untitled.md"), "utf8")).toBe("# Hi\n");
  const listed = await (await call(root, "GET", "/api/fork/notes")).json() as { notes: { path: string; folder: string; title: string }[] };
  expect(listed.notes.map((note) => note.path).sort()).toEqual(["Untitled 2.md", "Untitled.md", "banx-app/Release.md"]);
  expect(listed.notes.find((note) => note.folder === "banx-app")?.title).toBe("Release");
  expect((await call(root, "PATCH", "/api/fork/notes/file?path=Untitled.md", { title: "Untitled 2" })).status).toBe(409);
  const renamed = await (await call(root, "PATCH", "/api/fork/notes/file?path=Untitled.md", { title: "Ideas" })).json() as { path: string; text: string };
  expect(renamed).toMatchObject({ path: "Ideas.md", text: "# Hi\n" });
  expect((await call(root, "DELETE", "/api/fork/notes/file?path=Ideas.md")).status).toBe(200);
  expect((await call(root, "GET", "/api/fork/notes/file?path=Ideas.md")).status).toBe(404);
  expect((await call(root, "PUT", "/api/fork/notes/file?path=..%2Fx.md", { text: "" })).status).toBe(400);
});

test("a watching device only reads notes", async () => {
  const root = folder();
  writeFileSync(join(root, "Todo.md"), "x");
  expect((await call(root, "GET", "/api/fork/notes/file?path=Todo.md", undefined, true)).status).toBe(200);
  expect((await call(root, "PUT", "/api/fork/notes/file?path=Todo.md", { text: "y" }, true)).status).toBe(403);
  expect((await call(root, "POST", "/api/fork/notes", undefined, true)).status).toBe(403);
  expect(readFileSync(join(root, "Todo.md"), "utf8")).toBe("x");
});
