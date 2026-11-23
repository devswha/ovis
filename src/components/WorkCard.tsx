import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Layers, ListChecks } from "lucide-react";

import "./BackgroundTasks.css";
import "./WorkCard.css";

import { BackgroundAgentDetail } from "./BackgroundAgentDetail.tsx";
import { StepRow, TaskRow, workSummary } from "./BackgroundRows.tsx";
import { useT } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { planWaves } from "../lib/plan.ts";
import { useSettings } from "../lib/settings.ts";
import { usePanePlan, usePaneTasks } from "../lib/usePaneWork.ts";
import { usePageVisible } from "../lib/visibility.ts";
import { currentStepId, foldWorkCard, revealScrollTop, useWorkCardFolded, workCardShown } from "../lib/workCard.ts";
import type { OmoTask, PlanSummary } from "../../shared/protocol.ts";

interface WorkCardProps { paneId: string; plan: PlanSummary | null; count: number }

/**
 * The plan and the running background agents kept above the message box, as omp's and Claude Code's
 * terminal UIs keep their todo list above their input, for as long as the pane has either. Opt-in
 * (Settings → Chat → Composer, `workCard`): off, nothing is drawn and nothing is asked. The chip in
 * the status line stays as it is; this reads the same two lists (BackgroundRows.tsx, usePaneWork.ts).
 */
export function WorkCard(props: WorkCardProps) {
  const { settings } = useSettings();
  return settings.workCard && workCardShown(props.plan, props.count) ? <WorkCardBody {...props} /> : null;
}

function WorkCardBody({ paneId, plan, count }: WorkCardProps) {
  const t = useT();
  const machineId = useMachineId();
  const folded = useWorkCardFolded();
  const visible = usePageVisible();
  const bodyId = useId();
  const body = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<OmoTask | null>(null);
  const closeDetail = useCallback(() => setDetail(null), []);
  useEffect(() => { setDetail(null); }, [paneId, machineId]);

  const planShown = plan !== null;
  const tasksShown = count > 0;
  // a folded card, and a page nobody sees, ask for nothing; what was read stays for when they come back
  const reading = !folded && visible;
  const { steps, failed: planFailed, at: planAt, forget: forgetSteps } = usePanePlan(paneId, reading && planShown);
  const { tasks, moreRunning, failed, at: tasksAt, forget: forgetTasks } = usePaneTasks(paneId, reading && tasksShown);
  // a plan or a task list that went away is not shown again from memory when a new one comes
  useEffect(() => { if (!planShown) forgetSteps(); }, [planShown, forgetSteps]);
  useEffect(() => { if (!tasksShown) forgetTasks(); }, [tasksShown, forgetTasks]);

  const ordered = useMemo(() => steps === undefined || steps === null ? null : planWaves(steps).flat(), [steps]);
  const currentId = ordered === null ? null : currentStepId(ordered);
  // the step last brought into view: the list follows the plan to its next step, and leaves a reader
  // who scrolled elsewhere alone while the step stays the same
  const revealed = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (folded) { revealed.current = null; return; }
    const list = body.current;
    if (list === null || currentId === null || revealed.current === currentId) return;
    const row = list.querySelector<HTMLElement>("[data-current]");
    if (row === null) return;
    revealed.current = currentId;
    const top = revealScrollTop({ top: list.scrollTop, height: list.clientHeight }, { top: row.offsetTop, height: row.offsetHeight });
    if (top !== null) list.scrollTop = top;
  }, [folded, currentId, ordered]);

  const running = tasks?.filter((task) => task.status === "running") ?? [];
  const { current, name, busy } = workSummary(t, plan, count, tasksShown);
  const agentsShown = tasksShown && (tasks === null || running.length > 0 || failed);
  return <section className="work-card" aria-label={t("Plan and background tasks")}>
    <button type="button" className={`work-card-head${busy ? " is-busy" : ""}`} aria-label={name} title={name} aria-expanded={!folded} aria-controls={bodyId}
      // focus stays in the message box, whose keyboard a press here would close
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => foldWorkCard(!folded)}>
      {plan !== null
        ? <>
          <ListChecks className="work-card-mark" aria-hidden="true" />
          <span className="work-card-label">{t("Plan")}</span>
          <span className="work-card-figures" aria-hidden="true">{plan.done}/{plan.total}</span>
          {current !== null && <span className="work-card-current" aria-hidden="true">{current}</span>}
        </>
        : <>
          <Layers className="work-card-mark" aria-hidden="true" />
          <span className="work-card-label">{t(count === 1 ? "{n} background task" : "{n} background tasks", { n: count })}</span>
        </>}
      <span className="work-card-end" aria-hidden="true">
        {plan !== null && tasksShown && <span className="work-card-agents"><Layers />{count}</span>}
        <ChevronRight className="work-card-caret" />
      </span>
    </button>
    <div id={bodyId} ref={body} className="work-card-body" hidden={folded}>
      {!folded && <>
        {planShown && <>
          {steps === undefined && !planFailed && <p className="bg-tasks-note">{t("Reading the plan…")}</p>}
          {steps === null && <p className="bg-tasks-note">{t("This session keeps no plan right now")}</p>}
          {planFailed && <p className="bg-tasks-note" role="status">{t("Couldn't read the plan. Trying again…")}</p>}
          {ordered !== null && ordered.length > 0 && <ol className="bg-task-list">{ordered.map((step) => <StepRow key={step.id} step={step} at={planAt} compact current={step.id === currentId} />)}</ol>}
        </>}
        {agentsShown && <>
          <div className="menu-heading work-card-heading">{t("Background tasks")}</div>
          {tasks === null && !failed && <p className="bg-tasks-note">{t("Loading…")}</p>}
          {failed && tasks === null && <p className="bg-tasks-note">{t("Couldn't load the background tasks")}</p>}
          {failed && tasks !== null && <p className="bg-tasks-note" role="status">{t("Couldn't refresh: this is the list as it last read")}</p>}
          {running.length > 0 && <ul className="bg-task-list">{running.map((task) => <TaskRow key={task.id} task={task} at={tasksAt} compact expanded={detail?.id === task.id} onOpen={setDetail} />)}</ul>}
          {running.length > 0 && moreRunning > 0 && <p className="bg-tasks-note">{t("{n} more running", { n: moreRunning })}</p>}
        </>}
      </>}
    </div>
    {detail !== null && <BackgroundAgentDetail key={`${machineId}\0${paneId}\0${detail.id}`} paneId={paneId} task={detail} onClose={closeDetail} />}
  </section>;
}
