import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, FileDiff, FileMinus, FilePlus, FileSymlink, LoaderCircle } from "lucide-react";

import { RenderBoundary } from "../components/RenderBoundary.tsx";

import type { GithubEntry, GithubFilePatch, GithubPull, GithubPullDetail, GithubThread } from "../../shared/github.ts";
import { getJson } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { diffColorable, diffStyleFor } from "../lib/repoDiff.ts";
import { useSettings } from "../lib/settings.ts";
import { SHEET_QUERY } from "../lib/sheets.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { GithubThreadView } from "./GithubConversation.tsx";

// Ovis's own diff view, loaded with the first file opened, as the diff viewer loads it.
const RepoDiff = lazy(() => import("../components/RepoDiff.tsx"));

/** Every file's patch of a pull request, read once per visit to its page and kept for the next. */
const patchCache = new Map<string, Promise<Map<string, GithubFilePatch>>>();
function readPatches(pull: GithubPull): Promise<Map<string, GithubFilePatch>> {
  const hit = patchCache.get(pull.url);
  if (hit) return hit;
  const query = new URLSearchParams({ repo: pull.repository, number: String(pull.number), account: pull.account ?? "" });
  const value = getJson<{ files: GithubFilePatch[] }>(`/api/fork/github/pull/files?${query}`, { cache: "no-store" })
    .then(({ files }) => new Map(files.map((file) => [file.path, file])));
  patchCache.set(pull.url, value);
  value.catch(() => patchCache.delete(pull.url));
  return value;
}

/** A patch's rows, for a box tall enough to hold a short diff whole, before the view scrolls inside it. */
function rowsOf(patch: string): number {
  return patch.split("\n").filter((line) => !/^(diff --git|new file mode|deleted file mode|--- |\+\+\+ )/.test(line)).length;
}

/** A thread still on a line of the head's diff goes under that line; an outdated one, or one on no line, stays after the file's diff. */
const onDiff = (thread: GithubThread): boolean => !thread.outdated && thread.line !== null;

/**
 * The box of one file's diff: as tall as the diff with its notes, measured from the view's column,
 * up to 70% of the screen, past which the diff scrolls inside it. The rows of the patch size it
 * until the first measure.
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

type Patches = { status: "idle" } | { status: "loading" } | { status: "ready"; files: Map<string, GithubFilePatch> } | { status: "failed" };

const changeIcons = { added: FilePlus, deleted: FileMinus, renamed: FileSymlink, copied: FileSymlink, modified: FileDiff } as const;

/** The changed files; a tap opens a file's diff under it, in Ovis's own diff view, with the comments on its lines after it. */
export function GithubFiles({ pull, detail }: { pull: GithubPull; detail: GithubPullDetail }) {
  const t = useT();
  const { settings, resolvedEntry } = useSettings();
  const narrow = useMediaQuery(SHEET_QUERY);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [patches, setPatches] = useState<Patches>({ status: "idle" });
  const files = detail.files ?? [];
  const threads = threadsByFile(detail.conversation ?? []);

  const load = (): void => {
    if (patches.status === "loading" || patches.status === "ready") return;
    setPatches({ status: "loading" });
    readPatches(pull).then((next) => setPatches({ status: "ready", files: next }), () => setPatches({ status: "failed" }));
  };
  const toggle = (path: string): void => {
    load();
    setOpen((before) => { const next = new Set(before); if (!next.delete(path)) next.add(path); return next; });
  };
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
    const notes = (threads.get(path) ?? []).filter(onDiff).map((thread) => ({ side: thread.side, line: thread.line ?? 0, node: <GithubThreadView thread={thread} inDiff /> }));
    return <DiffBox rows={rowsOf(patch)}>
      <RenderBoundary resetKey={patch} fallback={() => <p className="fork-github-pull-dim" role="alert">{t("This change can't be shown.")}</p>}>
        <Suspense fallback={<p className="fork-github-pull-dim" role="status">{t("Opening…")}</p>}>
          <RepoDiff patch={patch} style={diffStyleFor(settings.diffStyle, narrow)} folded={false} wrap={settings.wrapCode} theme={resolvedEntry.mode} colored={diffColorable(path, patch)} notes={notes} />
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
      return <li key={file.path} className={`is-${file.change}${expanded ? " is-open" : ""}`}>
        <button type="button" className="fork-github-file" aria-expanded={expanded} onClick={() => toggle(file.path)}>
          <ChevronRight className="fork-github-file-chevron" aria-hidden="true" />
          <Icon aria-hidden="true" /><code dir="auto">{file.path}</code>
          {comments.length > 0 && <span className="fork-github-file-comments">{t("{count} threads", { count: comments.length })}</span>}
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
