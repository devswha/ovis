import type { ComponentType } from "react";
import { ChevronRight, Circle, CircleAlert, CircleCheck, CircleDot, CircleSlash, CircleX, type LucideProps } from "lucide-react";

import "./BackgroundTasks.css";

import { formatTokens } from "../lib/compose.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { formatElapsed, spanMs, taskElapsedMs, taskHasDetail } from "../lib/omoTasks.ts";
import type { OmoTask, PlanStep, PlanSummary } from "../../shared/protocol.ts";

const TASK_ICONS: Record<OmoTask["status"], ComponentType<LucideProps>> = {
  running: CircleDot, completed: CircleCheck, failed: CircleX, cancelled: CircleSlash, lost: CircleAlert,
};
const STEP_ICONS: Record<PlanStep["status"], ComponentType<LucideProps>> = { pending: Circle, in_progress: CircleDot, completed: CircleCheck };

const taskWords = (t: Translate): Record<OmoTask["status"], string> => ({
  running: t("running"), completed: t("done"), failed: t("failed"), cancelled: t("cancelled"), lost: t("lost"),
});
const stepWords = (t: Translate): Record<PlanStep["status"], string> => ({ pending: t("waiting"), in_progress: t("running"), completed: t("done") });

/** The dim line under a task's title: its state when it is neither running nor done, then what it ran as, how long it took and how much it used. */
function taskMeta(t: Translate, task: OmoTask, elapsed: number | null, word: string): string {
  const used = [
    task.category, task.model, elapsed === null ? null : formatElapsed(elapsed),
    task.turns === null ? null : t(task.turns === 1 ? "{n} turn" : "{n} turns", { n: task.turns }),
    task.tool_calls === null ? null : t(task.tool_calls === 1 ? "{n} tool call" : "{n} tool calls", { n: task.tool_calls }),
    task.tokens === null ? null : t("{n} tokens", { n: formatTokens(task.tokens) }),
  ].filter((item) => item !== null).join(" · ");
  return [task.status !== "running" && task.status !== "completed" ? word : null, used || null].filter((item) => item !== null).join(" · ");
}

/**
 * One background task. The chip's list draws it in full (its category, model, time, turns, tool calls
 * and tokens under its title), the pinned card `compact` (the title and the time on one line, the
 * whole title in its tooltip). A running task whose work this PC can show (`taskHasDetail`) is a
 * button that opens its detail through `onOpen`; any other row only shows. `at` is the PC's clock
 * as of the last read, which the time runs to.
 */
export function TaskRow({ task, at, expanded = false, onOpen, compact = false }: { task: OmoTask; at: number; expanded?: boolean; onOpen?: (task: OmoTask) => void; compact?: boolean }) {
  const t = useT();
  const Icon = TASK_ICONS[task.status];
  const word = taskWords(t)[task.status];
  const elapsed = taskElapsedMs(task, at);
  const meta = compact ? "" : taskMeta(t, task, elapsed, word);
  const tooltip = compact ? task.title : undefined;
  const main = <>
    <span className="bg-task-main">
      <span className="bg-task-title">{task.title}<span className="sr-only"> ({word})</span></span>
      {meta.length > 0 && <span className="bg-task-meta">{meta}</span>}
    </span>
    {compact && elapsed !== null && <span className="bg-task-elapsed">{formatElapsed(elapsed)}</span>}
  </>;
  if (task.status === "running" && onOpen !== undefined && taskHasDetail(task)) {
    return <li className={`bg-task is-${task.status} is-openable`}>
      <button type="button" className="bg-task-open" aria-haspopup="dialog" aria-expanded={expanded} title={tooltip} onClick={(event) => { event.currentTarget.focus(); onOpen(task); }}>
        <Icon className="bg-task-icon" aria-hidden="true" />
        {main}
        <ChevronRight className="bg-task-caret" aria-hidden="true" />
      </button>
    </li>;
  }
  return <li className={`bg-task is-${task.status}`} title={tooltip}>
    <Icon className="bg-task-icon" aria-hidden="true" />
    {main}
  </li>;
}

/**
 * One step of the plan. The chip's list draws it in full (what it does now, then its state, time and
 * teammate), the pinned card `compact` (the name alone, its state read aloud only, the whole name in
 * its tooltip). `current` marks the step the card keeps in view.
 */
export function StepRow({ step, at, compact = false, current = false }: { step: PlanStep; at: number; compact?: boolean; current?: boolean }) {
  const t = useT();
  const Icon = STEP_ICONS[step.status];
  const word = stepWords(t)[step.status];
  if (compact) {
    return <li className={`bg-task bg-step is-${step.status}`} title={step.label} aria-current={step.status === "in_progress" ? "step" : undefined} data-current={current ? "" : undefined}>
      <Icon className="bg-task-icon" aria-hidden="true" />
      <span className="bg-task-main"><span className="bg-task-title">{step.label}<span className="sr-only"> ({word})</span></span></span>
    </li>;
  }
  const elapsed = spanMs(step.started_at, step.ended_at, step.status === "in_progress", at);
  const meta = [word, elapsed === null ? null : formatElapsed(elapsed), step.owner].filter((part) => part !== null).join(" · ");
  return <li className={`bg-task bg-step is-${step.status}`}>
    <Icon className="bg-task-icon" aria-hidden="true" />
    <span className="bg-task-main">
      <span className="bg-task-title">{step.label}</span>
      {step.status === "in_progress" && step.active && step.active !== step.label && <span className="bg-step-active">{step.active}</span>}
      <span className="bg-task-meta">{meta}</span>
    </span>
  </li>;
}

export interface WorkSummary {
  /** what the tasks are called: their count, or only their kind when none runs */
  tasksLabel: string;
  /** the step in progress, in the agent's own words */
  current: string | null;
  /** all of it as one phrase, for the button's name and tooltip */
  name: string;
  /** a step or a task is left */
  busy: boolean;
}

/** The words the chip and the pinned card say of the plan and the tasks. */
export function workSummary(t: Translate, plan: PlanSummary | null, count: number, tasksShown: boolean): WorkSummary {
  const tasksLabel = count === 0 ? t("Background tasks") : t(count === 1 ? "{n} background task" : "{n} background tasks", { n: count });
  const planLabel = plan ? t("Plan: {done} of {total} done", { done: plan.done, total: plan.total }) : null;
  const current = plan?.current ? plan.current : null;
  return {
    tasksLabel,
    current,
    name: [planLabel, current, tasksShown ? tasksLabel : null].filter((part) => part !== null).join(" · "),
    busy: count > 0 || (plan !== null && plan.done < plan.total),
  };
}
