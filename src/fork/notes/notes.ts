import type { Note, NoteFile, NoteList } from "../../../shared/fork/notes.ts";
import { getJson, sendJson } from "../../lib/api.ts";

const fileUrl = (path: string) => `/api/fork/notes/file?${new URLSearchParams({ path })}`;

export const listNotes = async (): Promise<Note[]> => (await getJson<NoteList>("/api/fork/notes", { cache: "no-store" })).notes;
export const readNote = (path: string): Promise<NoteFile> => getJson<NoteFile>(fileUrl(path), { cache: "no-store" });
export const newNote = async (): Promise<NoteFile> => (await sendJson("/api/fork/notes", "POST", {})).json() as Promise<NoteFile>;
/** keepalive lets the last save of a page being left still reach the server */
export const saveNote = async (path: string, text: string, keepalive = false): Promise<NoteFile> =>
  (await sendJson(fileUrl(path), "PUT", { text }, keepalive)).json() as Promise<NoteFile>;
export const renameNote = async (path: string, title: string): Promise<NoteFile> => (await sendJson(fileUrl(path), "PATCH", { title })).json() as Promise<NoteFile>;
export const deleteNote = async (path: string): Promise<void> => { await sendJson(fileUrl(path), "DELETE", {}); };

/** The notes every searched word is in: the title, its folder or its text. */
export function searchedNotes(notes: readonly Note[], query: string): Note[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...notes];
  return notes.filter((note) => {
    const haystack = `${note.folder}\n${note.title}\n${note.text}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
