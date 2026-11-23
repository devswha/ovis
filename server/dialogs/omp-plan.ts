import type { DialogReader } from "./registry.ts";
import type { InteractionPlan } from "./interaction-plan.ts";
import type { CardText } from "../../shared/protocol.ts";
import { ANSI_RE, KEY, type ParsedPrompt, finishPrompt, findLastIndex, keySteps, navigationKeys, normalizeText, own } from "./shared.ts";

/**
 * omp's plan mode in the terminal (19.1.1). The agent proposes a plan (`propose <slug>`) and omp opens its Plan
 * Review over the whole screen, which takes the keys until it is answered:
 *
 *   ╭─ Plan Review ───────────────────────────────╮
 *   │  Add README.md to /tmp/omp-proto          █ │   the plan, scrolling, with its bar;
 *   │  Context                                  │ │   a wider pane also draws the sections
 *   │  …                                        │ │   down its left (`┬` in the top border)
 *   ├─────────────────────────────────────────────┤
 *   │ Plan mode - next step                       │
 *   │ continue with  ◂  smol  ◀ default ▶  slow … │   the model that executes it, with
 *   │   ↳ Claude Opus 5.5                         │   ←/→ (only when roles give several)
 *   │ ❯ Approve and execute                       │
 *   │   Approve and compact context               │   `Refine plan` comes first, but only
 *   │   Approve and keep context (~60k / 1m)      │   once the plan has a comment
 *   │   Save                                      │
 *   ├─────────────────────────────────────────────┤
 *   │ ↑/↓ select · ⏎ confirm · ←/→ model · c cop… │
 *   ╰─────────────────────────────────────────────╯
 *
 * Tab goes from region to region (actions, the sections when drawn, the plan), and the footer names the keys of the
 * region that has them: `↑/↓ select · ⏎ confirm` for the rows, `↑/↓ scroll` in the plan, `↑/↓ section` in the sections.
 * The cursor `❯` stays on its row while another region has the keys, but ↑/↓ there scroll the plan or move through its
 * sections, and ↑ on the first row leaves the rows: so the rows are answered only once the screen shows them to have the
 * keys (Tab from the plan, Tab twice from the sections). Esc closes the review in any region and leaves plan mode on.
 * A narrow pane clips the footer's tail (`c cop…`), never its first keys.
 *
 * Not read, and left to the terminal: a note being typed or picked over a comment, the review once answered
 * (`Applying your selection…`), a pane too short to show the box whole. omp 19.1.1's source (plan-review-overlay.ts)
 * draws all of this; Save opens a path prompt of its own (plan-save-overlay.ts), which no reader knows.
 */
const TOP_RE = /^(?:╭─|\+-) Plan Review [─┬+-]*[╮+]$/u;
const BOTTOM_RE = /^(?:╰─+╯|\+-+\+)$/u;
const DIVIDER_RE = /^(?:├[─┴]*┤|\+[-+]+\+)$/u;
const ROW_RE = /^[│|] ?(.*?)\s*[│|]$/u;
const HEADER = "Plan mode - next step";
const ACTION_RE = /^(?:([❯›>\uf054]) |  )(\S.*)$/u;
const HINT_RE = /^\S+ (select|scroll|section)(?: ·|…|$)/u;
const FOCUS = { select: "actions", scroll: "body", section: "toc" } as const;

type Focus = NonNullable<ParsedPrompt["ompPlan"]>["focus"];

/** The lines of a screen with their frame's ends and the pane's padding trimmed, and the last one drawn. */
function plain(screen: string): { lines: string[]; end: number } {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trim());
  return { lines, end: findLastIndex(lines, (line) => line !== "") };
}

/** whether `shown` is the label `full` (or the start of it, as a narrow pane clips it with `…`), alone or followed by a count */
function names(shown: string, full: string): boolean {
  if (shown.startsWith(full)) return shown.length === full.length || shown[full.length] === " ";
  return shown.endsWith("…") && shown.length > 8 && full.startsWith(shown.slice(0, -1));
}

/** What a choice does, in the bridge's own words: the review's rows say only what they are called. */
function choiceWords(label: string): CardText | null {
  if (names(label, "Approve and execute")) return own("Executes the plan now, starting fresh with just the plan");
  if (names(label, "Approve and compact context")) return own("Executes the plan now, after summarizing this conversation");
  if (names(label, "Approve and keep context")) return own("Executes the plan now, keeping this conversation");
  if (names(label, "Refine plan")) return own("Sends your comments to the agent and keeps planning");
  if (names(label, "Save")) return own("Saves the plan to a file. The review stays open, and nothing runs");
  return null;
}

/** The keys that bring the rows to have the keys: Tab leaves the plan for them, and the sections for the plan first. */
const TABS: Record<Focus, string[]> = { actions: [], body: [KEY.tab], toc: [KEY.tab, KEY.tab] };
/** where Tab takes the keys from each region, as far as a plan walks it */
const NEXT_FOCUS: Record<Focus, Focus> = { toc: "body", body: "actions", actions: "toc" };

/**
 * Whether the screen is the review's box whole: a top border naming it, rows and dividers down to a bottom border that
 * ends the screen. The shape the reader needs of it, rows and footer apart.
 */
function reviewBox(lines: string[], end: number): { top: number; div: number } | null {
  if (end < 7 || !BOTTOM_RE.test(lines[end]!)) return null;
  const top = findLastIndex(lines.slice(0, end), (line) => TOP_RE.test(line));
  if (top < 0) return null;
  for (let at = top + 1; at < end; at += 1) if (!ROW_RE.test(lines[at]!) && !DIVIDER_RE.test(lines[at]!)) return null;
  // the footer is the one row over the bottom border, under a divider; the rows are under the divider before that
  if (!DIVIDER_RE.test(lines[end - 2]!) || !ROW_RE.test(lines[end - 1]!)) return null;
  const div = findLastIndex(lines.slice(0, end - 2), (line) => DIVIDER_RE.test(line));
  return div > top ? { top, div } : null;
}

export function parseOmpPlanReview(screen: string): ParsedPrompt | null {
  const { lines, end } = plain(screen);
  const box = reviewBox(lines, end);
  if (box === null) return null;
  const hint = HINT_RE.exec(ROW_RE.exec(lines[end - 1]!)![1]!);
  if (hint === null) return null;
  const focus = FOCUS[hint[1] as keyof typeof FOCUS];
  const inner = lines.slice(box.div + 1, end - 2).map((line) => ROW_RE.exec(line)?.[1]);
  const header = inner[0] ?? "";
  if (header !== HEADER && !(header.endsWith("…") && header.length > 8 && HEADER.startsWith(header.slice(0, -1)))) return null;
  const action = (row: string | undefined): { label: string; cursor: boolean } | null => {
    const match = row === undefined ? null : ACTION_RE.exec(row);
    // the model's name sits under the slider, indented as a row is
    return match === null || match[2]!.startsWith("↳") ? null : { label: match[2]!, cursor: match[1] !== undefined };
  };
  // a slider row and the model it picks may stand between the header and the rows
  let first = 1;
  while (first < 3 && first < inner.length && action(inner[first]) === null) first += 1;
  const rows = inner.slice(first).map(action);
  if (rows.length === 0 || rows.some((row) => row === null)) return null;
  const choices = rows as { label: string; cursor: boolean }[];
  if (choices.filter((row) => row.cursor).length !== 1) return null;
  const cursor = choices.findIndex((row) => row.cursor);
  const labels = choices.map((row) => row.label);
  return finishPrompt("omp", {
    kind: "plan", title: own("Plan review"), question: own("Choose how to continue"), body: null,
    options: [
      ...choices.map((row) => ({ label: row.label, description: choiceWords(row.label) })),
      { label: own("Cancel"), description: own("Closes the review. Plan mode stays on") },
    ],
    multi_select: false, custom_option_index: null,
  }, {
    responder: "omp-plan", menuLabels: [...labels, "Cancel"], selectedIndex: cursor, checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: choices.length, ompPlan: { focus },
    // each choice from the cursor's row: the keys that give the rows the keys first, the moves, then Enter; Esc is the way out
    optionSteps: [...choices.map((_, index) => keySteps([...TABS[focus], ...navigationKeys(index - cursor), KEY.enter])), keySteps([KEY.escape])],
  });
}

/**
 * The answer's plan: every key goes out only over a screen that still shows this review (its id: the same rows and
 * words) with the keys and the cursor where the keys sent so far left them, and the commit only on the row chosen. A key
 * that did not do what it was sent for, a review answered or replaced meanwhile, a row omp skips (one it disables)
 * leave the cursor elsewhere, and nothing more is sent.
 */
export function ompPlanInteraction(parsed: ParsedPrompt): InteractionPlan {
  const start = parsed.ompPlan?.focus ?? "actions";
  const steps = parsed.optionSteps ?? [];
  const plan: InteractionPlan = {
    cursor: parsed.selectedIndex,
    toggles: 0,
    moves: (answer) => steps[answer]?.slice(0, -1) ?? [],
    matches: (screen) => {
      const shown = parseOmpPlanReview(screen);
      if (shown === null || shown.id !== parsed.id) return false;
      let focus = start;
      for (let tab = 0; tab < plan.toggles; tab += 1) focus = NEXT_FOCUS[focus];
      return shown.ompPlan?.focus === focus && shown.selectedIndex === plan.cursor;
    },
    commit: (answer) => steps[answer]?.at(-1) ?? { pick: true },
    terminalFallback: (answer) => steps[answer] === undefined,
  };
  return plan;
}

/**
 * The review is on the screen but no card reads it (a note being typed, the review answered and applying, a pane too
 * short for its top): any key a fallback card sent would act on a screen nobody read, Enter on the row the review holds.
 */
export function ompPlanReviewWaits(screen: string): boolean {
  const { lines, end } = plain(screen);
  if (end < 0 || !BOTTOM_RE.test(lines[end]!) || parseOmpPlanReview(screen) !== null) return false;
  return lines.slice(0, end).some((line) => TOP_RE.test(line) || ROW_RE.exec(line)?.[1] === HEADER);
}

const EXIT_TOP_RE = /^(?:╭─|\+-) Exit plan mode\? [─+-]*[╮+]$/u;
const EXIT_HINT_RE = /^\S+ navigate {1,2}\S+ select {1,2}\S+ cancel$/u;
const EXIT_ROW_RE = /^ (?:([❯›>\uf054]) |  )(\S.*)$/u;
/** omp's status row, drawn right under a dialog that stands in the editor's place (live.ts) */
const STATUS_ROW_RE = /^(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \S+|π) · /u;

/**
 * `/plan` while plan mode is on asks to leave it (hook confirm, in the editor's place):
 *
 *   ╭─ Exit plan mode? ───────────────────────────╮
 *   │ This exits plan mode without approving a    │
 *   │ plan.                                       │
 *   │  ❯ Yes                                      │
 *   │    No                                       │
 *   │ ↑/↓ navigate  ⏎ select  ⎋ cancel            │
 *   ╰─────────────────────────────────────────────╯
 *
 * An ordinary two-row choice: moved to by the arrows, picked with Enter.
 */
export function parseOmpPlanExit(screen: string): ParsedPrompt | null {
  const { lines, end: last } = plain(screen);
  let end = last;
  if (end > 0 && STATUS_ROW_RE.test(lines[end]!)) end = lines[end - 1] === "" ? end - 2 : end - 1;
  if (end < 4 || !BOTTOM_RE.test(lines[end]!)) return null;
  const top = findLastIndex(lines.slice(0, end), (line) => EXIT_TOP_RE.test(line));
  if (top < 0) return null;
  const inner = lines.slice(top + 1, end).map((line) => ROW_RE.exec(line)?.[1]);
  if (inner.some((row) => row === undefined)) return null;
  const rows = inner as string[];
  if (!EXIT_HINT_RE.test(rows.filter((row) => row !== "").at(-1) ?? "")) return null;
  const first = rows.findIndex((row) => EXIT_ROW_RE.test(row));
  if (first < 0) return null;
  const choices: { label: string; cursor: boolean }[] = [];
  for (let at = first; at < rows.length; at += 1) {
    if (rows[at] === "") break;
    const match = EXIT_ROW_RE.exec(rows[at]!);
    if (match === null) break;
    choices.push({ label: match[2]!, cursor: match[1] !== undefined });
  }
  if (choices.length < 2 || choices.filter((row) => row.cursor).length !== 1) return null;
  const message = normalizeText(rows.slice(0, first).join(" "));
  return finishPrompt("omp", {
    kind: "menu", title: lines[top]!.replace(/^(?:╭─|\+-) /u, "").replace(/ [─+-]*[╮+]$/u, ""), question: message, body: null,
    options: choices.map((row) => ({ label: row.label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "omp-plan-exit", menuLabels: choices.map((row) => row.label), selectedIndex: choices.findIndex((row) => row.cursor),
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
  });
}

export const readers: readonly DialogReader[] = [
  {
    id: "omp-plan", agents: ["omp"], priority: 25,
    // the keys of one answer go out one at a time, each over a screen read for the keys before it
    reread: "each-move", list: "none",
    interaction: ompPlanInteraction,
    parse: parseOmpPlanReview,
  },
  {
    id: "omp-plan-exit", agents: ["omp"], priority: 26,
    reread: "before-commit", list: "none",
    parse: parseOmpPlanExit,
  },
];
