import { noteTitle, type Note, type NoteFile } from "../../../shared/fork/notes.ts";

/** The demo's notes (site/demo/transport.ts): kept in memory, as the server keeps them in `~/Notes`. */
const minutes = (count: number) => new Date(Date.now() - count * 60_000).toISOString();
const files = new Map<string, NoteFile>([
  ["Todo.md", { path: "Todo.md", updated_at: minutes(4), text: "# This week\n\n- [x] Ship the retry flag\n- [ ] Review the export guard\n- [ ] Write the changelog\n\nAsk **mira** about the backoff cap." }],
  ["checkout-api/Release list.md", { path: "checkout-api/Release list.md", updated_at: minutes(60 * 26), text: "## Before the release\n\n1. Bump the version\n2. Run `bun run check`\n3. Tag it\n\n> Never tag by hand on a Friday." }],
  ["Ideas.md", { path: "Ideas.md", updated_at: minutes(60 * 24 * 3), text: "A notes place next to the inbox, so plans live where the agents are." }],
  ["Agents/Follow-ups.md", { path: "Agents/Follow-ups.md", updated_at: minutes(30), text: "## Follow-ups\n\n- [ ] checkout-api: the export guard test is flaky on CI" }],
  ["Agents/Lessons.md", { path: "Agents/Lessons.md", updated_at: minutes(60 * 5), text: "## Lessons\n\n- checkout-api: run the retry tests before pushing" }],
]);

const listed = (file: NoteFile): Note => ({ path: file.path, title: noteTitle(file.path), folder: file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "", updated_at: file.updated_at, text: file.text });
const fail = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status });

export function demoNotes(method: string, url: URL, body: Record<string, unknown> | undefined): Response {
  if (url.pathname === "/api/fork/notes") {
    if (method === "GET") return Response.json({ notes: [...files.values()].map(listed).sort((a, b) => b.updated_at.localeCompare(a.updated_at)) });
    let count = 1;
    while (files.has(count === 1 ? "Untitled.md" : `Untitled ${count}.md`)) count++;
    const file = { path: count === 1 ? "Untitled.md" : `Untitled ${count}.md`, text: "", updated_at: new Date().toISOString() };
    files.set(file.path, file);
    return Response.json(file);
  }
  const path = url.searchParams.get("path") ?? "";
  const file = files.get(path);
  if (file === undefined) return fail("not_found", "This note is gone", 404);
  if (method === "GET") return Response.json(file);
  if (method === "DELETE") { files.delete(path); return Response.json({ ok: true }); }
  if (method === "PUT") { const next = { ...file, text: String(body?.text ?? ""), updated_at: new Date().toISOString() }; files.set(path, next); return Response.json(next); }
  const name = `${String(body?.title ?? "").trim()}.md`;
  const next = [path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", name].filter(Boolean).join("/");
  if (next !== path && files.has(next)) return fail("name_taken", "Another note has that name", 409);
  files.delete(path);
  const renamed = { ...file, path: next };
  files.set(next, renamed);
  return Response.json(renamed);
}
