/**
 * On herdr-core an agent's status is what it reports (OSC 7501), and some ask without saying so: Codex keeps
 * `working` while its question waits, Claude Code reports nothing at its folder-trust prompt. While the server
 * reads such an asking on a terminal's screen (prompt.ts `waitingCard`), the terminal waits for its user: blocked,
 * with the card's kind where the agent's own report gives none. Read, never guessed: only a card a reader returns
 * for that terminal counts, and a terminal no agent runs in is never read. The agent's own `blocked` stands over
 * it, kind and words included. The wait is only what is shown and alerted: what the agent reported stays what the
 * turn is counted from (server/core/status.ts).
 *
 * A wait ends when reads find no card: at the first such read after an answer from a card (`answer`), else at the
 * second in a row, so a screen caught mid-repaint does not end it and raise a second alert. A read that says
 * nothing (it raced a change, or failed) changes nothing; ten of them in a row end the wait rather than keep a
 * terminal stuck in it. A terminal whose agent is gone (it exited at its card) ends its wait at once. The same card
 * redrawn, or another card while one waits, is the same wait. Each wait's card is remembered (`remembered`, kept by
 * the caller across a restart of the server), so the same card found again after a restart is told as `resumed`:
 * the wait it already had, not a new one.
 */
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

export type WaitingKind = "permission" | "question" | null;
/** what one read found: the agent's asking (its kind and the card's own id), none (null), or nothing to go by (undefined) */
export type CardRead = { kind: WaitingKind; id: string } | null | undefined;

/** reads in a row that find no card before a wait ends, unless an answer went to the pane */
const EMPTY_READS_END = 2;
/** reads in a row that say nothing before a wait ends */
const FAILED_READS_END = 10;
/** panes read at the same time, however many may wait */
const READS_AT_ONCE = 4;

interface Wait { kind: WaitingKind; id: string; empty: number; failed: number }

export class CardWaits {
  private readonly waits = new Map<string, Wait>();
  /** panes a card's answer went to since their last read that found no card */
  private readonly answered = new Set<string>();
  /** each pane's card from before this server started, until the pane is read or found gone */
  private readonly before: Map<string, string>;

  constructor(
    private readonly read: (pane: HerdrPane, panes: HerdrPane[]) => Promise<CardRead>,
    /** a wait began (true; `resumed`: the card this pane waited on before the server restarted) or ended (false) */
    private readonly changed: (paneId: string, waiting: boolean, resumed: boolean) => void,
    /** the waits' cards when this server started, and where they are kept as they change */
    private readonly remembered: { load: () => Record<string, string>; save: (cards: Record<string, string>) => void } = { load: () => ({}), save: () => {} },
  ) {
    this.before = new Map(Object.entries(remembered.load()));
  }

  waiting(paneId: string): boolean {
    return this.waits.has(paneId);
  }

  /** the kind of the card a pane waits on; undefined while it waits on none */
  kindOf(paneId: string): WaitingKind | undefined {
    return this.waits.get(paneId)?.kind;
  }

  /** An answer from a card went to the pane: its next read that finds no card ends the wait. */
  answer(paneId: string): void {
    if (this.waits.has(paneId)) this.answered.add(paneId);
  }

  /** The pane is gone, or what is reported next tells its status: what it waited on goes, told to nobody. */
  forget(paneId: string): void {
    const had = this.waits.delete(paneId) || this.before.delete(paneId);
    this.answered.delete(paneId);
    if (had) this.save();
  }

  /**
   * One read of each pane `reads` picks (`only`: of those panes alone), and of each pane that waits. A pane no longer
   * listed is forgotten, and a waiting pane no agent runs in any more ends its wait. Panes whose own trackers tell
   * their status (`skip`) are never read.
   */
  async tick(panes: HerdrPane[], reads: (pane: HerdrPane) => boolean, skip: (paneId: string) => boolean = () => false, only?: ReadonlySet<string>): Promise<void> {
    const listed = new Set(panes.map((pane) => pane.pane_id));
    for (const paneId of [...this.waits.keys(), ...this.before.keys()]) if (!listed.has(paneId)) this.forget(paneId);
    for (const pane of panes) if (!pane.agent && this.waits.has(pane.pane_id)) this.end(pane.pane_id);
    const candidates = panes.filter((pane) => pane.agent && !skip(pane.pane_id) && (only === undefined || only.has(pane.pane_id)) && (this.waits.has(pane.pane_id) || reads(pane)));
    for (let at = 0; at < candidates.length; at += READS_AT_ONCE) {
      const batch = candidates.slice(at, at + READS_AT_ONCE);
      const found = await Promise.all(batch.map((pane) => this.read(pane, panes).catch((): CardRead => undefined)));
      batch.forEach((pane, index) => this.settle(pane.pane_id, found[index]));
    }
  }

  private settle(paneId: string, read: CardRead): void {
    const wait = this.waits.get(paneId);
    if (read === undefined) {
      if (wait && ++wait.failed >= FAILED_READS_END) this.end(paneId);
      return;
    }
    if (read === null) {
      // a card remembered from before the restart is not shown any more: nothing to resume
      if (this.before.delete(paneId)) this.save();
      if (!wait) return;
      wait.failed = 0;
      if (this.answered.has(paneId) || ++wait.empty >= EMPTY_READS_END) this.end(paneId);
      return;
    }
    if (wait) {
      if (wait.id !== read.id) { wait.id = read.id; this.save(); }
      wait.kind = read.kind;
      wait.empty = 0;
      wait.failed = 0;
      return;
    }
    const resumed = this.before.get(paneId) === read.id;
    this.before.delete(paneId);
    this.waits.set(paneId, { kind: read.kind, id: read.id, empty: 0, failed: 0 });
    this.save();
    this.changed(paneId, true, resumed);
  }

  private end(paneId: string): void {
    this.waits.delete(paneId);
    this.answered.delete(paneId);
    this.save();
    this.changed(paneId, false, false);
  }

  private save(): void {
    this.remembered.save(Object.fromEntries([...this.before, ...[...this.waits].map(([paneId, wait]) => [paneId, wait.id] as const)]));
  }

  /** What a status shows as while its pane waits on a card: blocked, unless the agent said so itself. */
  status(paneId: string, reported: AgentStatus): AgentStatus {
    return this.waits.has(paneId) && reported !== "blocked" ? "blocked" : reported;
  }

  /** A snapshot with each waiting pane blocked, its card's kind where the agent's own report gives none. */
  apply(snapshot: SessionSnapshot): SessionSnapshot {
    if (this.waits.size === 0) return snapshot;
    const waiting = (pane: { pane_id: string; agent_status: AgentStatus }) => this.waits.has(pane.pane_id) && pane.agent_status !== "blocked";
    return {
      ...snapshot,
      panes: snapshot.panes.map((pane) => {
        if (!waiting(pane)) return pane;
        const kind = this.waits.get(pane.pane_id)!.kind;
        return { ...pane, agent_status: "blocked" as const, ...(kind ? { agent_kind: kind } : {}) };
      }),
      agents: snapshot.agents.map((agent) => waiting(agent) ? { ...agent, agent_status: "blocked" as const } : agent),
    };
  }
}
