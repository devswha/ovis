import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { NOTE_SEARCHED, noteTitle, type Note, type NoteFile } from "../../shared/fork/notes.ts";
import { conflictResponse, jsonResponse } from "../http.ts";

/** The folder notes live in: plain Markdown files an agent or `cat` reads as they are. */
export const notesFolder = (): string => process.env.OVIS_NOTES_DIR || join(homedir(), "Notes");

const MAX_NOTES = 500;
const MAX_DEPTH = 3;
const MAX_BYTES = 2_000_000;

const refused = (code: string, message: string, status = 400) => jsonResponse({ error: { code, message } }, status);

/** A note's path inside `root`, or null: relative, `.md`, no hidden or parent segments. */
export function notePath(root: string, asked: unknown): string | null {
  if (typeof asked !== "string" || asked.includes("\0") || asked.includes("\\")) return null;
  const parts = asked.split("/");
  if (parts.length > MAX_DEPTH + 1 || parts.some((part) => part === "" || part.startsWith(".") || part.trim() !== part)) return null;
  if (!/\.md$/i.test(asked)) return null;
  const path = resolve(root, asked);
  return path.startsWith(root + sep) ? path : null;
}

/** A file name from a title the user typed: the characters a file name cannot hold dropped. */
export function noteFileName(title: string): string | null {
  const name = title.replace(/[/\\\0:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return name === "" ? null : `${name.slice(0, 120)}.md`;
}

/** Every note in the folder, newest first. */
export async function listNotes(root: string): Promise<Note[]> {
  const found: Note[] = [];
  const walk = async (folder: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= MAX_NOTES || entry.name.startsWith(".")) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory() && depth < MAX_DEPTH) await walk(path, depth + 1);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        try {
          const [info, text] = await Promise.all([stat(path), readFile(path, "utf8")]);
          const inside = relative(root, path).split(sep).join("/");
          found.push({ path: inside, title: noteTitle(inside), folder: inside.includes("/") ? dirname(inside) : "",
            updated_at: info.mtime.toISOString(), text: text.slice(0, NOTE_SEARCHED) });
        } catch { /* gone while read */ }
      }
    }
  };
  await walk(root, 0);
  return found.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

async function readNote(root: string, inside: string): Promise<NoteFile> {
  const path = join(root, inside);
  const [info, text] = await Promise.all([stat(path), readFile(path, "utf8")]);
  return { path: inside, text, updated_at: info.mtime.toISOString() };
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/** A free name for a new note in the folder: `Untitled.md`, `Untitled 2.md`, … */
async function freeName(root: string, folder: string, name: string): Promise<string> {
  const base = name.replace(/\.md$/i, "");
  for (let count = 1; ; count++) {
    const inside = [folder, count === 1 ? `${base}.md` : `${base} ${count}.md`].filter(Boolean).join("/");
    if (!(await exists(join(root, inside)))) return inside;
  }
}

/**
 * /api/fork/notes: GET lists, POST makes a new one. /api/fork/notes/file?path=: GET reads one, PUT saves its text,
 * PATCH renames it ({ title }), DELETE removes it. A watching device only reads.
 */
export async function handleNotes(request: Request, url: URL, readOnly: boolean, root = notesFolder()): Promise<Response> {
  const { method } = request;
  if (method !== "GET" && readOnly) return refused("read_only", "This device only watches", 403);
  if (url.pathname === "/api/fork/notes") {
    if (method === "GET") return jsonResponse({ notes: await listNotes(root) });
    if (method !== "POST") return refused("method_not_allowed", "Use GET or POST", 405);
    await mkdir(root, { recursive: true });
    const inside = await freeName(root, "", "Untitled");
    await writeFile(join(root, inside), "", { flag: "wx" });
    return jsonResponse(await readNote(root, inside));
  }
  const asked = url.searchParams.get("path");
  const path = notePath(root, asked);
  if (path === null) return refused("bad_path", "Name a note in the notes folder");
  const inside = asked!;
  try {
    if (method === "GET") return jsonResponse(await readNote(root, inside));
    if (method === "DELETE") { await unlink(path); return jsonResponse({ ok: true }); }
    let body: { text?: unknown; title?: unknown };
    try { body = await request.json(); } catch { body = {}; }
    if (method === "PUT") {
      if (typeof body.text !== "string" || body.text.length > MAX_BYTES) return refused("bad_request", "Send the note's text");
      if (!(await exists(path))) return refused("not_found", "This note is gone", 404);
      await writeFile(path, body.text);
      return jsonResponse(await readNote(root, inside));
    }
    if (method === "PATCH") {
      const name = typeof body.title === "string" ? noteFileName(body.title) : null;
      if (name === null) return refused("bad_request", "Name the note");
      const folder = inside.includes("/") ? dirname(inside) : "";
      const next = [folder, name].filter(Boolean).join("/");
      if (next !== inside && await exists(join(root, next))) return conflictResponse("name_taken", "Another note has that name");
      await rename(path, join(root, next));
      return jsonResponse(await readNote(root, next));
    }
    return refused("method_not_allowed", "Use GET, PUT, PATCH or DELETE", 405);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return refused("not_found", "This note is gone", 404);
    throw error;
  }
}
