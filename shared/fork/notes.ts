/** Notes (src/fork/notes, server/fork/notes.ts): Markdown files in the server's notes folder, `~/Notes`. */

/** A note: its path in the folder (`Todo.md`, `banx-app/Release list.md`), its title and folder from that path. */
export interface Note {
  path: string;
  title: string;
  /** the subfolder it is in, "" at the top */
  folder: string;
  /** last change, ISO time */
  updated_at: string;
  /** its text, for the list's search: the first NOTE_SEARCHED characters */
  text: string;
}

export interface NoteList { notes: Note[] }

/** One note whole, to edit. */
export interface NoteFile { path: string; text: string; updated_at: string }

export const NOTE_SEARCHED = 20_000;

/** The note's title from its path: its file name without `.md`. */
export function noteTitle(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}
