import type { ConversationMetadata, HerdrPane, PaneContext, PlanStep, PlanSummary } from "../shared/protocol.ts";
import { planSummary } from "../shared/plans.ts";
import { plain } from "./claude-subagents.ts";
import { PLAN_BUDGET, planState, readPlan, type PlanSource } from "./session-plan-reader.ts";
export { forgetPlans, readPlan, type PlanSource } from "./session-plan-reader.ts";

export { planSummary } from "../shared/plans.ts";

export interface SessionPlanDeps {
  claudePath: (paneId: string) => string | null;
  omoPath?: (paneId: string) => string | null;
  codexPath: (pane: HerdrPane) => Promise<string | null>;
  /**
   * omp's transcript, found as asynchronously as Codex's rollout and asked again the same way. One that fails for a moment
   * (a process read, herdr busy) leaves the session already found for the same pane in place. Without it an omp pane has no plan.
   */
  ompPath?: (pane: HerdrPane) => Promise<string | null>;
  onChange: (paneId: string, summary: PlanSummary | null) => void;
  onContext?: (paneId: string, context: PaneContext | null) => void;
  claudeWindow?: (transcriptPath: string, model: string | null) => number | null;
  now?: () => number;
  retryMs?: number;
  relocateMs?: number;
  pollMs?: number;
}

interface Tracked {
  key: string;
  at: number;
  where: { source: PlanSource; path: string } | null;
  sig: string | null;
  summary: PlanSummary | null;
  metadata: ConversationMetadata | null;
  context: PaneContext | null;
}

export class SessionPlans {
  private readonly panes = new Map<string, Tracked>();
  private readonly wanted = new Map<string, string>();
  private refreshed = false;
  /** the look under way for each pane, and the key it is made for: its answer is kept only while it is still the pane's */
  private readonly looking = new Map<string, { key: string }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SessionPlanDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  summaryOf(paneId: string): PlanSummary | null {
    return this.panes.get(paneId)?.summary ?? null;
  }

  contextOf(paneId: string): PaneContext | null {
    return this.panes.get(paneId)?.context ?? null;
  }

  planOf(pane: HerdrPane | undefined): PlanStep[] | null {
    const where = pane !== undefined && this.known(pane) ? this.panes.get(pane.pane_id)?.where : null;
    return where ? readPlan(where.source, where.path, { left: 0 }) : null;
  }

  known(pane: HerdrPane): boolean {
    const tracked = this.panes.get(pane.pane_id);
    return tracked?.where != null && tracked.key === keyOf(pane);
  }

  async refresh(panes: HerdrPane[]): Promise<void> {
    this.wanted.clear();
    this.refreshed = true;
    for (const pane of panes) if (pane.agent === "claude" || pane.agent === "codex" || pane.agent === "omo" || pane.agent === "omp") this.wanted.set(pane.pane_id, keyOf(pane));
    for (const [paneId, tracked] of this.panes) {
      if (this.wanted.has(paneId)) continue;
      this.panes.delete(paneId);
      if (tracked.summary !== null) this.deps.onChange(paneId, null);
      if (tracked.context !== null) this.deps.onContext?.(paneId, null);
    }
    await Promise.all(panes.map((pane) => this.ensure(pane)));
  }

  async ensure(pane: HerdrPane, asked = false): Promise<void> {
    if (pane.agent !== "claude" && pane.agent !== "codex" && pane.agent !== "omo" && pane.agent !== "omp") return;
    const key = keyOf(pane);
    // a look under way for another session of the pane, or for what it ran before, stands for it no more
    if (this.looking.get(pane.pane_id)?.key !== key) this.looking.delete(pane.pane_id);
    if (pane.agent === "omo") {
      const path = this.deps.omoPath?.(pane.pane_id) ?? null;
      this.track(pane.pane_id, key, path === null ? null : { source: "omo-session", path });
      return;
    }
    if (pane.agent === "claude") {
      const path = this.deps.claudePath(pane.pane_id);
      this.track(pane.pane_id, key, path === null ? null : { source: "claude-transcript", path });
      return;
    }
    // Codex's rollout and omp's transcript are found by a look that takes time and may find nothing yet: it is made again as the
    // session or folder changes, and as time passes (retryMs while none is known, relocateMs once one is)
    const source = pane.agent === "codex" ? "codex-transcript" : "omp-transcript";
    const find = pane.agent === "codex" ? this.deps.codexPath : this.deps.ompPath;
    const tracked = this.panes.get(pane.pane_id);
    const due = !tracked || tracked.key !== key || this.now() - tracked.at >= (tracked.where === null ? this.deps.retryMs ?? 15_000 : this.deps.relocateMs ?? 30_000);
    if (!due || this.looking.has(pane.pane_id)) return;
    const look = { key };
    this.looking.set(pane.pane_id, look);
    try {
      const path = (await find?.(pane).catch(() => null)) ?? null;
      // the pane's session was looked up again since: what the look before it found is for no session the pane runs, a request's too
      if (this.looking.get(pane.pane_id) !== look) return;
      if (!asked && this.refreshed && this.wanted.get(pane.pane_id) !== key) return;
      const current = this.panes.get(pane.pane_id);
      const kept = path === null && source === "omp-transcript" && current?.key === key ? current.where : null;
      this.track(pane.pane_id, key, path === null ? kept : { source, path });
    } finally {
      if (this.looking.get(pane.pane_id) === look) this.looking.delete(pane.pane_id);
    }
  }

  private track(paneId: string, key: string, where: { source: PlanSource; path: string } | null): void {
    const current = this.panes.get(paneId);
    const same = current !== undefined && current.where?.path === where?.path && current.where?.source === where?.source;
    const sameSession = same && current.key === key;
    this.panes.set(paneId, { key, at: this.now(), where, sig: sameSession ? current.sig : null, summary: current?.summary ?? null, metadata: sameSession ? current.metadata : null, context: current?.key === key ? current.context : null });
    if (current !== undefined && current.key !== key && current.context !== null) this.deps.onContext?.(paneId, null);
  }

  poll(): void {
    const budget = { left: PLAN_BUDGET };
    for (const [paneId, tracked] of this.panes) {
      if (tracked.where === null) {
        tracked.metadata = null;
        this.tellSummary(paneId, tracked, null);
      } else {
        const stat = plain(tracked.where.path);
        const sig = stat === null ? null : `${stat.id}:${stat.size}`;
        if (sig === null || sig !== tracked.sig) {
          const read = planState(tracked.where.source, tracked.where.path, budget);
          if (!read.behind) tracked.sig = sig;
          if (read.steps !== null || !read.behind) {
            tracked.metadata = read.metadata;
            this.tellSummary(paneId, tracked, planSummary(read.steps));
          }
        }
      }
      this.tellContext(paneId, tracked);
    }
  }

  private tellSummary(paneId: string, tracked: Tracked, summary: PlanSummary | null): void {
    if (JSON.stringify(summary) === JSON.stringify(tracked.summary)) return;
    tracked.summary = summary;
    this.deps.onChange(paneId, summary);
  }

  private tellContext(paneId: string, tracked: Tracked): void {
    const read = tracked.metadata?.context ?? null;
    const window = read !== null && tracked.where?.source === "claude-transcript" ? this.deps.claudeWindow?.(tracked.where.path, tracked.metadata?.model ?? null) ?? null : null;
    const context = read === null ? null : window === null ? read : { ...read, window };
    if (JSON.stringify(context) === JSON.stringify(tracked.context)) return;
    tracked.context = context;
    this.deps.onContext?.(paneId, context);
  }
}

const keyOf = (pane: HerdrPane): string => `${pane.agent}\0${pane.agent_session?.value ?? ""}\0${pane.cwd ?? ""}`;
