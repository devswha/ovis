import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ConversationPart } from "../../shared/protocol.ts";
import type { ToolPart, ThinkingPart } from "../lib/workBlocks.ts";

export type WorkItem =
  | { kind: "run"; start: number; parts: (ToolPart | ThinkingPart)[] }
  | { kind: "part"; part: ConversationPart };

/** Fold only adjacent calls and thinking; narration and todo updates end a run. */
export function workItems(visible: ConversationPart[], parts: ConversationPart[], apart: (part: ConversationPart) => boolean = () => false): WorkItem[] {
  const items: WorkItem[] = [];
  for (const part of visible) {
    const last = items.at(-1);
    if ((part.kind !== "tool" && part.kind !== "thinking") || apart(part)) items.push({ kind: "part", part });
    else if (last?.kind === "run") last.parts.push(part);
    else items.push({ kind: "run", start: parts.indexOf(part), parts: [part] });
  }
  return items;
}

export interface RunCount { name: string; count: number }

/** Calls by outcome in first-seen order. A cut-off settled call is done, not running. */
export function runCounts(run: readonly (ToolPart | ThinkingPart)[], live: boolean): { done: RunCount[]; failed: RunCount[]; running: RunCount[] } {
  const outcomes = { done: new Map<string, number>(), failed: new Map<string, number>(), running: new Map<string, number>() };
  for (const part of run) {
    const outcome = part.kind === "tool" && part.error ? "failed" : part.kind === "tool" && part.running && live ? "running" : "done";
    const name = runName(part);
    outcomes[outcome].set(name, (outcomes[outcome].get(name) ?? 0) + 1);
  }
  const list = (counts: Map<string, number>) => [...counts].map(([name, count]) => ({ name, count }));
  return { done: list(outcomes.done), failed: list(outcomes.failed), running: list(outcomes.running) };
}

function runName(part: ToolPart | ThinkingPart): string {
  if (part.kind === "thinking") return "think";
  if (part.name !== "mcp") return part.name;
  try {
    const tool = (JSON.parse(part.input) as { tool?: unknown }).tool;
    return typeof tool === "string" && tool.length > 0 ? tool : part.name;
  } catch { return part.name; }
}

/** Keeps row state in the transcript's memory, and its ordinary rows in the caller. */
export function WorkRun({ run, live, expandThinking, chosen, setOpen, children }: {
  run: (ToolPart | ThinkingPart)[]; live: boolean; expandThinking: boolean;
  chosen: boolean | null; setOpen: (value: boolean) => void; children: ReactNode;
}) {
  const open = chosen ?? (expandThinking && run.some((part) => part.kind === "thinking"));
  const { done, failed, running } = runCounts(run, live);
  const counts = (list: RunCount[]) => list.map(({ name, count }) => `${name} ×${count}`).join(", ");
  const shown = [["done", "✓", done], ["failed", "✗", failed], ["running", "•", running]] as const;
  return <div className="work-row work-run">
    <button type="button" className="work-run-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <span className="work-run-counts">{shown.filter(([, , list]) => list.length > 0).map(([outcome, mark, list], index) =>
        <span key={outcome} className={`work-run-${outcome}`}>{index > 0 && " · "}<span className="work-run-mark">{mark}</span> {counts(list)}</span>)}</span>
    </button>
    {open && <div className="work-run-rows">{children}</div>}
  </div>;
}
