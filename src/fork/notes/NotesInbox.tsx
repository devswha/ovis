import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ChevronRight, Plus, Search, Trash2, X } from "lucide-react";

import { noteTitle, type Note, type NoteFile } from "../../../shared/fork/notes.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { ApiError } from "../../lib/api.ts";
import { useT } from "../../lib/i18n.ts";
import { ago } from "../github/GithubConversation.tsx";
import { useKeptScroll } from "../github/github.ts";
import { closePlace, onPlaceLeft } from "../inbox/place.ts";
import { deleteNote, listNotes, newNote, readNote, renameNote, saveNote, searchedNotes } from "./notes.ts";
import "./Notes.css";

const NoteEditor = lazy(() => import("./NoteEditor.tsx"));

/* What Notes keeps while the app is open: the list, each note read, the open one and the search. */
let notes: Note[] | null = null;
const files = new Map<string, NoteFile>();
let open: string | null = null;
let searched = "";
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const useNotes = () => useSyncExternalStore(subscribe, () => notes, () => null);
const useOpen = () => useSyncExternalStore(subscribe, () => open, () => null);

/** A note as the server now has it: kept, and moved to the top of the list. */
function kept(file: NoteFile, was = file.path): void {
  files.delete(was);
  files.set(file.path, file);
  if (notes !== null) {
    const listed = notes.find((note) => note.path === was);
    const note: Note = { path: file.path, title: noteTitle(file.path), folder: listed?.folder ?? "", updated_at: file.updated_at, text: file.text };
    notes = [note, ...notes.filter((other) => other.path !== was && other.path !== file.path)];
  }
  if (open === was) open = file.path;
  emit();
}

/* A phone opens a note on a history entry of its own over the list, so Back returns to the list. */
const NOTE_KEY = "ovis:fork-note";
let onNoteEntry = false;
const noteEntry = (): boolean => typeof window !== "undefined" && (window.history.state as Record<string, unknown> | null)?.[NOTE_KEY] === true;
function openNote(path: string, phone: boolean): void {
  if (phone && !noteEntry()) { window.history.pushState({ ...(window.history.state ?? {}), [NOTE_KEY]: true }, ""); onNoteEntry = true; }
  open = path; emit();
}
function closeNote(): void {
  if (onNoteEntry && noteEntry()) window.history.back();
  else { open = null; emit(); }
}
if (typeof window !== "undefined") window.addEventListener("popstate", () => {
  if (!noteEntry() && onNoteEntry) { onNoteEntry = false; open = null; emit(); }
});
onPlaceLeft((from) => { if (from === "notes" && open !== null) { open = null; emit(); } });

interface ViewProps { wide: boolean; watching: boolean }

/** The agents' notebook (the notes skill): its own section at the end of the list, folded until opened here. */
const AGENTS_FOLDER = "Agents";
const AGENTS_OPEN_KEY = "ovis:fork-notes-agents-open";
const inAgents = (note: Note): boolean => note.folder === AGENTS_FOLDER || note.folder.startsWith(`${AGENTS_FOLDER}/`);
const loadAgentsOpen = (): boolean => { try { return window.localStorage.getItem(AGENTS_OPEN_KEY) === "1"; } catch { return false; } };

/** The agent inbox's column while Notes is its place: search and New over the notes, newest first. */
export function NotesInbox({ wide, watching }: ViewProps) {
  const t = useT();
  const list = useNotes();
  const current = useOpen();
  const [error, setError] = useState(false);
  const [query, setQueryState] = useState(searched);
  const setQuery = (next: string): void => { searched = next; setQueryState(next); };
  const [searchAsked, setSearchAsked] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(loadAgentsOpen);
  const toggleAgents = (): void => setAgentsOpen((was) => {
    try { window.localStorage.setItem(AGENTS_OPEN_KEY, was ? "0" : "1"); } catch { /* storage may be disabled */ }
    return !was;
  });
  const search = useRef<HTMLInputElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const scroll = useKeptScroll<HTMLDivElement>("notes", list !== null && (wide || current === null));
  useEffect(() => {
    // coming back shows the last list at once and reads it again behind it: an agent may have written one
    let cancelled = false;
    listNotes().then((next) => { if (!cancelled) { notes = next; setError(false); emit(); } }, () => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);
  const create = async (): Promise<void> => {
    try {
      const file = await newNote();
      kept(file);
      openNote(file.path, !wide);
    } catch { setError(true); }
  };

  if (!wide && current !== null) return <NotePage key={current} path={current} wide={false} watching={watching} />;

  const searchLabel = t("Search notes");
  const searchOpen = !wide || searchAsked || query !== "";
  const searchField = (searchOpen || wide) && <div className="inbox-search" role="search">
    {!wide && <Search className="inbox-search-glass" aria-hidden="true" />}
    <input ref={search} className="input inbox-search-input" type="search" value={query} placeholder={searchLabel} aria-label={searchLabel}
      autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="search" onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        if (query !== "") setQuery("");
        else if (wide && searchToggle.current?.getClientRects().length) { setSearchAsked(false); searchToggle.current.focus(); }
        else event.currentTarget.blur();
      }} />
    {query !== "" && <button type="button" className="inbox-search-clear" aria-label={t("Clear search|fork")} onClick={() => { setQuery(""); search.current?.focus(); }}><X aria-hidden="true" /></button>}
  </div>;
  const newButton = !watching && <button type="button" className="icon-button inbox-round fork-notes-new" aria-label={t("New note")} title={t("New note")} onClick={() => void create()}><Plus aria-hidden="true" /></button>;
  const shown = list === null ? [] : searchedNotes(list, query);
  const mine = shown.filter((note) => !inAgents(note));
  const agents = shown.filter(inAgents);
  // a search shows what it found, folded or not
  const agentsShown = agentsOpen || query.trim() !== "";
  const row = (note: Note, folder: string) => <li key={note.path} className={`fork-github-row${current === note.path ? " is-current" : ""}`}>
    <button type="button" className="fork-github-summary" aria-current={current === note.path ? "true" : undefined} title={note.path} onClick={() => openNote(note.path, !wide)}>
      <span className="fork-github-row-title" dir="auto">{note.title}</span>
      <span className="fork-github-row-sub">{folder !== "" && <>{folder} · </>}{ago(note.updated_at)}</span>
    </button>
  </li>;
  return <section className={`mode-inbox fork-github fork-notes${wide ? " is-wide" : ""}`} aria-label={t("Notes")}>
    <header className={`inbox-top${wide && searchOpen ? " is-search-open" : ""}`}>
      {wide ? <>
        {searchField}
        <button type="button" ref={searchToggle} className="icon-button inbox-round inbox-search-toggle" aria-label={searchLabel} title={searchLabel} aria-expanded={searchOpen}
          onClick={() => { if (!searchOpen) setSearchAsked(true); else if (query === "") setSearchAsked(false); else search.current?.focus(); }}><Search aria-hidden="true" /></button>
        {newButton}
      </> : <>
        <button type="button" className="icon-button inbox-round" aria-label={t("Back|fork inbox")} title={t("Back|fork inbox")} onClick={closePlace}><ArrowLeft aria-hidden="true" /></button>
        <span className="fork-github-gap" />
        {newButton}
      </>}
    </header>
    <div ref={scroll} className="inbox-scroll">
      {error && list !== null && <p className="fork-github-note" role="alert">{t("Could not read the notes")}</p>}
      {list === null ? <p className="inbox-empty" role={error ? "alert" : "status"}>{error ? t("Could not read the notes") : t("Reading notes…")}</p>
        : shown.length > 0 ? <>
          {mine.length > 0 && <ul className="fork-github-list">{mine.map((note) => row(note, note.folder))}</ul>}
          {agents.length > 0 && <section className="fork-github-group" aria-label={t("Agent notes")}>
            <h3><button type="button" className="fork-github-group-head" aria-expanded={agentsShown} onClick={toggleAgents}>
              <ChevronRight aria-hidden="true" /><span>{t("Agent notes")}</span><span className="fork-github-group-count">{agents.length}</span>
            </button></h3>
            {agentsShown && <ul className="fork-github-list">{agents.map((note) => row(note, note.folder.slice(AGENTS_FOLDER.length + 1)))}</ul>}
          </section>}
        </>
        : <p className="inbox-empty" role="status">{query.trim() !== "" ? t("No notes match") : t("No notes yet")}</p>}
    </div>
    {!wide && <div className="inbox-foot">{searchField}</div>}
  </section>;
}

/** The wide pane while Notes is the place: the open note, or a word on how to open one. */
export function NotesPane({ watching }: { watching: boolean }) {
  const t = useT();
  const current = useOpen();
  return <div className="fork-github-pane fork-notes-pane">
    {current === null ? <p className="inbox-unchosen" role="status">{t("Choose a note, or make a new one with +.")}</p>
      : <NotePage key={current} path={current} wide watching={watching} />}
  </div>;
}

/** Saved this long after the last key, and at once when the note is left or the page hidden. */
const SAVE_AFTER_MS = 800;

function NotePage({ path, wide, watching }: { path: string; wide: boolean; watching: boolean }) {
  const t = useT();
  const [file, setFile] = useState<NoteFile | null>(() => files.get(path) ?? null);
  const [failed, setFailed] = useState<string | null>(null);
  const [title, setTitle] = useState(() => noteTitle(path));
  const [deleting, setDeleting] = useState(false);
  const where = useRef(path);
  const saved = useRef<string | null>(file?.text ?? null);
  const pending = useRef<(() => string) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const titleField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    readNote(path).then((read) => {
      if (cancelled || pending.current !== null) return;
      files.set(read.path, read); saved.current = read.text; setFile(read);
    }, (reason: unknown) => { if (!cancelled && files.get(path) === undefined) setFailed(reason instanceof ApiError && reason.status === 404 ? t("This note is gone") : t("Could not read this note")); });
    return () => { cancelled = true; };
  }, [path, t]);

  const flush = useCallback((keepalive = false): Promise<void> => {
    clearTimeout(timer.current);
    const read = pending.current;
    if (read === null) return Promise.resolve();
    pending.current = null;
    const text = read();
    if (text === saved.current) return Promise.resolve();
    saved.current = text;
    const at = where.current;
    return saveNote(at, text, keepalive).then((next) => { kept(next, at); setFailed(null); }, () => { saved.current = null; setFailed(t("Not saved: check the connection")); });
  }, [t]);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === "hidden") void flush(true); };
    document.addEventListener("visibilitychange", hidden);
    return () => { document.removeEventListener("visibilitychange", hidden); void flush(true); };
  }, [flush]);
  // a new note asks for its name first
  useEffect(() => { if (file?.text === "" && /^Untitled( \d+)?$/.test(title)) titleField.current?.select(); }, [file === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const rename = async (): Promise<void> => {
    const name = title.trim();
    const was = where.current;
    if (name === "" || name === noteTitle(was)) { setTitle(noteTitle(was)); return; }
    await flush();
    try {
      const next = await renameNote(was, name);
      where.current = next.path;
      setTitle(noteTitle(next.path));
      kept(next, was);
    } catch (reason) {
      setFailed(reason instanceof ApiError && reason.code === "name_taken" ? t("Another note has that name") : t("Could not rename this note"));
      setTitle(noteTitle(was));
    }
  };

  return <article className="fork-note" aria-label={title}>
    <header className="fork-note-top">
      {!wide && <button type="button" className="icon-button inbox-round" aria-label={t("Back|fork inbox")} title={t("Back|fork inbox")} onClick={() => { void flush(); closeNote(); }}><ArrowLeft aria-hidden="true" /></button>}
      <input ref={titleField} className="fork-note-title" value={title} aria-label={t("Note name")} readOnly={watching} dir="auto"
        onChange={(event) => setTitle(event.target.value)} onBlur={() => void rename()}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === "Escape") { setTitle(noteTitle(where.current)); event.currentTarget.blur(); } }} />
      {!watching && <button type="button" className="icon-button inbox-round" aria-label={t("Delete note")} title={t("Delete note")} onClick={() => setDeleting(true)}><Trash2 aria-hidden="true" /></button>}
    </header>
    {failed !== null && <p className="fork-github-note" role="alert">{failed}</p>}
    <div className="fork-note-body">
      {file === null ? failed === null && <p className="inbox-empty" role="status">{t("Reading notes…")}</p>
        : <Suspense fallback={<p className="inbox-empty" role="status">{t("Reading notes…")}</p>}>
          <NoteEditor text={file.text} editable={!watching} label={title}
            onText={(read) => { pending.current = read; clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), SAVE_AFTER_MS); }} />
        </Suspense>}
    </div>
    {deleting && <ConfirmDialog title={t("Delete {name}?", { name: title })} body={t("Removes its file from the notes folder.")} confirmLabel={t("Delete note")}
      onClose={() => setDeleting(false)} onConfirm={async () => {
        pending.current = null; clearTimeout(timer.current);
        const was = where.current;
        await deleteNote(was);
        files.delete(was);
        if (notes !== null) notes = notes.filter((note) => note.path !== was);
        setDeleting(false);
        if (!wide) closeNote(); else { open = null; emit(); }
      }} />}
  </article>;
}
