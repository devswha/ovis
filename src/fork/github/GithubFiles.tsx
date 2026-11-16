import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, FileDiff, FileMinus, FilePlus, FileSymlink, LoaderCircle, MessageSquare } from "lucide-react";

import { RenderBoundary } from "../../components/RenderBoundary.tsx";

import type { GithubEntry, GithubFilePatch, GithubPull, GithubPullDetail, GithubThread } from "../../../shared/github.ts";
import { getJson } from "../../lib/api.ts";
import { useT } from "../../lib/i18n.ts";
import { diffColorable, diffStyleFor } from "../../lib/repoDiff.ts";
import { useSettings } from "../../lib/settings.ts";
import { SHEET_QUERY } from "../../lib/sheets.ts";
import { useMediaQuery } from "../../lib/useMediaQuery.ts";
import type { DiffMark } from "../../components/RepoDiff.tsx";
import { GithubThreadView, onDiff } from "./GithubConversation.tsx";

// Ovis's own diff view, loaded with the first file opened, as the diff viewer loads it.
const RepoDiff = lazy(() => import("../../components/RepoDiff.tsx"));

/** Every file's patch of a pull request at one head commit, read once and kept for this visit to the app. */
const patchCache = new Map<string, Promise<Map<string, GithubFilePatch>>>();
/** The same patches once read, so a page opened again draws its open files at once. */
const patchesRead = new Map<string, Map<string, GithubFilePatch>>();
function readPatches(pull: GithubPull, key: string, head: string, base: string): Promise<Map<string, GithubFilePatch>> {
  const hit = patchCache.get(key);
  if (hit) return hit;
  const query = new URLSearchParams({ repo: pull.repository, number: String(pull.number), account: pull.account ?? "", head, base });
  const value = getJson<{ files: GithubFilePatch[] }>(`/api/fork/github/pull/files?${query}`, { cache: "no-store" })
    .then(({ files }) => { const read = new Map(files.map((file) => [file.path, file])); patchesRead.set(key, read); return read; });
  patchCache.set(key, value);
  value.catch(() => patchCache.delete(key));
  return value;
}

/** How long a jump waits for its file's patch and diff to draw the thread, in frames (about 3s) */
const JUMP_FRAMES = 180;

/** The files each pull request's tab was left with open, and the line each was brought to. */
const views = new Map<string, { open: ReadonlySet<string>; marks: ReadonlyMap<string, DiffMark> }>();

/** A patch's rows, for a box tall enough to hold a short diff whole, before the view scrolls inside it. */
function rowsOf(patch: string): number {
  return patch.split("\n").filter((line) => !/^(diff --git|new file mode|deleted file mode|--- |\+\+\+ )/.test(line)).length;
}

/**
 * The box of one file's diff: as tall as the diff with its notes, measured from the view's column,
 * so the page is the only thing that scrolls up and down. The rows of the patch size it until the
 * first measure.
 */
function DiffBox({ rows, children }: { rows: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const host = box.current;
    if (host === null) return;
    let column: Element | null = null;
    const measure = new ResizeObserver(() => { if (column !== null) setHeight(column.getBoundingClientRect().height || null); });
    // the column appears once the lazy view has loaded
    const find = (): void => {
      const next = host.querySelector(".repo-diff-column");
      if (next === column) return;
      if (column !== null) measure.unobserve(column);
      column = next;
      if (column !== null) measure.observe(column);
    };
    const appear = new MutationObserver(find);
    appear.observe(host, { childList: true, subtree: true });
    find();
    return () => { appear.disconnect(); measure.disconnect(); };
  }, []);
  return <div ref={box} className="fork-github-diff" style={{ ["--rows" as string]: rows, ...height !== null && { ["--content" as string]: `${height}px` } }}>{children}</div>;
}

/** The line threads of every review, by the file they are on. */
function threadsByFile(entries: GithubEntry[]): Map<string, GithubThread[]> {
  const byFile = new Map<string, GithubThread[]>();
  for (const entry of entries) {
    if (entry.kind !== "review") continue;
    for (const thread of entry.threads) byFile.set(thread.path, [...byFile.get(thread.path) ?? [], thread]);
  }
  return byFile;
}

/** A line to bring into view: a thread's, asked for from the conversation; `seq` tells one ask from the next. */
export interface FilesJump { path: string; side: "old" | "new"; line: number; seq: number }

/** The line of a file's first thread in its diff, which opening the file brings into view. */
function firstMark(threads: GithubThread[]): DiffMark | null {
  const first = threads.filter(onDiff).sort((a, b) => (a.line ?? 0) - (b.line ?? 0))[0];
  return first ? { side: first.side, line: first.line ?? 0, start: 0, end: 0 } : null;
}

type Patches = { status: "idle" } | { status: "loading" } | { status: "ready"; files: Map<string, GithubFilePatch> } | { status: "failed" };

const changeIcons = { added: FilePlus, deleted: FileMinus, renamed: FileSymlink, copied: FileSymlink, modified: FileDiff } as const;

/** The changed files; a tap opens a file's diff under it, in Ovis's own diff view, with the comments on its lines after it. */
export function GithubFiles({ pull, detail, jump = null }: { pull: GithubPull; detail: GithubPullDetail; jump?: FilesJump | null }) {
  const t = useT();
  const { settings, resolvedEntry } = useSettings();
  const narrow = useMediaQuery(SHEET_QUERY);
  // a new head commit has new patches: they are read again for it
  const key = `${pull.url}@${detail.base}@${detail.head_sha}`;
  const kept = views.get(pull.url);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => kept?.open ?? new Set());
  const [patches, setPatches] = useState<Patches>(() => { const read = patchesRead.get(key); return read ? { status: "ready", files: read } : { status: "idle" }; });
  const files = detail.files ?? [];
  const threads = threadsByFile(detail.conversation ?? []);
  // the line each open file's diff is brought to: its first thread, or the one asked for
  const [marks, setMarks] = useState<ReadonlyMap<string, DiffMark>>(() => kept?.marks ?? new Map());
  const rows = useRef(new Map<string, HTMLLIElement>());

  const load = (): void => {
    if (patches.status === "loading" || patches.status === "ready") return;
    setPatches({ status: "loading" });
    readPatches(pull, key, detail.head_sha, detail.base).then((next) => setPatches({ status: "ready", files: next }), () => setPatches({ status: "failed" }));
  };
  useEffect(() => { views.set(pull.url, { open, marks }); }, [pull.url, open, marks]);
  // files left open whose patches are not read yet (another head commit, or the first read failed)
  useEffect(() => { if (open.size > 0) load(); }, []);
  const mark = (path: string, next: DiffMark | null): void => setMarks((before) => {
    const after = new Map(before);
    if (next === null) after.delete(path); else after.set(path, next);
    return after;
  });
  const toggle = (path: string): void => {
    load();
    const opening = !open.has(path);
    if (opening) mark(path, firstMark(threads.get(path) ?? []));
    setOpen((before) => { const next = new Set(before); if (opening) next.add(path); else next.delete(path); return next; });
  };
  // a thread asked for from the conversation: its file opens with the thread's line marked, and the page
  // scrolls to that thread once its diff has drawn it (to the file's row until then)
  useEffect(() => {
    if (jump === null) return;
    load();
    mark(jump.path, { side: jump.side, line: jump.line, start: 0, end: 0 });
    setOpen((before) => new Set([...before, jump.path]));
    let frame = requestAnimationFrame(() => rows.current.get(jump.path)?.scrollIntoView({ block: "start" }));
    let tries = 0;
    const find = (): void => {
      const note = rows.current.get(jump.path)?.querySelector(`[data-fork-line="${jump.side}:${jump.line}"]`);
      if (note) { note.scrollIntoView({ block: "center" }); return; }
      if (++tries < JUMP_FRAMES) frame = requestAnimationFrame(find);
    };
    const wait = requestAnimationFrame(find);
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(wait); };
  }, [jump?.seq]);
  const all = open.size === files.length && files.length > 0;
  const toggleAll = (): void => {
    if (all) { setOpen(new Set()); return; }
    load();
    setOpen(new Set(files.map((file) => file.path)));
  };

  if (files.length === 0) return <p className="fork-github-pull-dim">{t("No files changed.")}</p>;
  const diffOf = (path: string) => {
    if (patches.status === "loading" || patches.status === "idle") return <p className="fork-github-pull-dim" role="status"><LoaderCircle className="fork-github-spin" aria-hidden="true" /> {t("Opening…")}</p>;
    if (patches.status === "failed") return <p className="fork-github-pull-error" role="alert">{t("Could not read this pull request's files")}</p>;
    const patch = patches.files.get(path)?.patch ?? null;
    if (patch === null) return <p className="fork-github-pull-dim">{t("GitHub shows no diff for this file: it is binary or too large.")}</p>;
    const notes = (threads.get(path) ?? []).filter(onDiff).map((thread) => ({ side: thread.side, line: thread.line ?? 0, node: <div data-fork-line={`${thread.side}:${thread.line ?? 0}`}><GithubThreadView thread={thread} inDiff /></div> }));
    return <DiffBox rows={rowsOf(patch)}>
      <RenderBoundary resetKey={patch} fallback={() => <p className="fork-github-pull-dim" role="alert">{t("This change can't be shown.")}</p>}>
        <Suspense fallback={<p className="fork-github-pull-dim" role="status">{t("Opening…")}</p>}>
          <RepoDiff patch={patch} style={diffStyleFor(settings.diffStyle, narrow)} folded={false} wrap={settings.wrapCode} theme={resolvedEntry.mode} colored={diffColorable(path, patch)} notes={notes} active={marks.get(path) ?? null} />
        </Suspense>
      </RenderBoundary>
    </DiffBox>;
  };

  return <>
    <div className="fork-github-files-bar">
      <button type="button" className="btn" onClick={toggleAll}>{all ? t("Collapse all") : t("Expand all")}</button>
    </div>
    <ul className="fork-github-files">{files.map((file) => {
      const Icon = changeIcons[file.change];
      const expanded = open.has(file.path);
      const comments = threads.get(file.path) ?? [];
      return <li key={file.path} ref={(node) => { if (node) rows.current.set(file.path, node); else rows.current.delete(file.path); }} className={`is-${file.change}${expanded ? " is-open" : ""}`}>
        <button type="button" className="fork-github-file" aria-expanded={expanded} onClick={() => toggle(file.path)}>
          <ChevronRight className="fork-github-file-chevron" aria-hidden="true" />
          <Icon aria-hidden="true" /><code dir="auto">{file.path}</code>
          {comments.length > 0 && <span className="fork-github-file-comments" title={t("{count} threads", { count: comments.length })}><MessageSquare aria-hidden="true" />{comments.length}</span>}
          <span className="fork-github-file-lines"><span className="is-added">+{file.additions}</span> <span className="is-removed">−{file.deletions}</span></span>
        </button>
        {expanded && <div className="fork-github-file-open">
          {diffOf(file.path)}
          {(patches.status === "ready" && patches.files.get(file.path)?.patch ? comments.filter((thread) => !onDiff(thread)) : comments)
            .map((thread, index) => <GithubThreadView key={index} thread={thread} />)}
        </div>}
      </li>;
    })}</ul>
    {detail.changed_files > files.length && <p className="fork-github-pull-dim">{t("And {count} more files", { count: detail.changed_files - files.length })}</p>}
  </>;
}
