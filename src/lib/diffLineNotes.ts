import type { AgentStatus, RepoDiffFilePatch } from "../../shared/protocol.ts";
import { MAX_COMPOSER_CHARS } from "./compose.ts";
import type { Translate } from "./i18n.ts";
import { messageWithComments, type ReplyComment } from "./replyComments.ts";
import type { DiffFindLine } from "./repoDiffFind.ts";

/**
 * A note on one line of a file's diff (#1603): it waits with the reply comments (lib/replyComments.ts)
 * for the next message of the pane the diff was opened from, and goes first in it as a quote. The
 * quote holds what was captured when the note was begun, so a diff that changes later does not move it.
 */
export interface DiffNoteCapture {
  /** the PC's name */
  machine: string;
  /** the repository's top folder on that PC */
  repository: string;
  /** capturedComparison's words */
  comparison: string;
  path: string;
  line: DiffFindLine;
}

/** A fence of backticks longer than the longest run in `text` (at least three): no line of it can close the fence. */
export function codeFence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** The patch's identity: 64-bit FNV-1a of its text, in hex. The same patch, the same identity. */
export function patchIdentity(patch: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < patch.length; index++) {
    hash ^= BigInt(patch.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * The comparison as it was read: two full commits, a branch's HEAD, base and merge base, or (the
 * working tree and the index, which have no commit of their own) HEAD and the patch's identity.
 */
export function capturedComparison(answer: RepoDiffFilePatch, patch: string): string {
  const head = answer.repository.head;
  const onHead = head === null ? "before the first commit" : `on HEAD ${head}`;
  switch (answer.scope) {
    case "workspace": return `working tree ${onHead}, patch ${patchIdentity(patch)}`;
    case "staged": return `staged ${onHead}, patch ${patchIdentity(patch)}`;
    case "commit": return `commits ${answer.base ?? ""}..${answer.head ?? head ?? "HEAD"}`;
    case "branch": {
      const pinned = answer.comparison;
      if (pinned === null) return `branch since ${answer.base ?? ""} ${onHead}, patch ${patchIdentity(patch)}`;
      return `branch since ${answer.base ?? pinned.base_oid}: HEAD ${pinned.head_oid}, base ${pinned.base_oid}, merge base ${pinned.merge_base_oid}`;
    }
  }
}

const KIND_WORD = { addition: "added", deletion: "removed", context: "unchanged" } as const;

/** One line of the quote, whatever a path or a folder holds. */
const oneLine = (text: string): string => text.replace(/[\r\n]+/g, " ");

/** The quote the note goes with: where the line is, what was compared, and the line's text in a fence. */
export function diffNoteQuote(capture: DiffNoteCapture): string {
  const { line } = capture;
  const fence = codeFence(line.text);
  return [
    `Diff note on ${oneLine(capture.path)}, ${line.side} side, line ${line.line} (${KIND_WORD[line.kind]})`,
    `PC ${oneLine(capture.machine)}, repository ${oneLine(capture.repository)}`,
    `Compared as captured: ${oneLine(capture.comparison)}`,
    fence,
    line.text,
    fence,
  ].join("\n");
}

/**
 * The logical line of a row the diff drew (lib/repoDiffFind.ts): a row on the old side by its old
 * number (a removed line, or in split an unchanged one), a row on the new side by its new number.
 */
export function lineAtRow(lines: readonly DiffFindLine[], side: "deletions" | "additions", lineNumber: number): DiffFindLine | null {
  return lines.find((line) => (side === "deletions" ? line.oldLine : line.newLine) === lineNumber) ?? null;
}

/** Whether the next message would pass the composer's limit with this note and the draft typed so far. */
export function noteOverflows(waiting: readonly ReplyComment[], draft: string, quote: string, note: string): boolean {
  return messageWithComments([...waiting, { id: "", quote, comment: note.trim() }], draft).length > MAX_COMPOSER_CHARS;
}

export type NoteBlock = "no-pane" | "pane-gone" | "watching" | "no-agent";

/**
 * Why the diff's own pane cannot take a note, or null when it can. Only that pane ever does: never
 * one on another PC, nor whichever is selected now.
 */
export function noteBlock({ paneId, pane, watching }: { paneId: string | null; pane: { agent?: string | null; agent_status: AgentStatus } | undefined; watching: boolean }): NoteBlock | null {
  if (paneId === null) return "no-pane";
  if (pane === undefined) return "pane-gone";
  if (watching) return "watching";
  if (pane.agent === null || pane.agent === undefined || pane.agent === "") return "no-agent";
  return null;
}

/** A NoteBlock in the user's words, shown where the note would be begun. */
export function noteBlockWord(t: Translate, block: NoteBlock): string {
  switch (block) {
    case "no-pane": return t("Notes go to the pane this diff came from, and it has none.");
    case "pane-gone": return t("The pane this diff came from has closed, so a note has nowhere to go.");
    case "watching": return t("This device can only watch.");
    case "no-agent": return t("No agent is running in the pane this diff came from.");
  }
}
