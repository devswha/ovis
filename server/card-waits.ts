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
 * terminal stuck in it. A terminal whose agent is gone (it exited at its card), or whose status a tracker of its own
 * tells from now on (`owned`), ends its wait at once, and a terminal forgotten while its screen is read, or waits to
 * be (closed, or its agent gone), drops that read. The same card redrawn is the same wait. Another card in its
 * place is the next wait: the first one ends and that one begins, alerted as any other. Nothing is kept across a
 * restart of the server: a card still shown then is waited on, and alerted, once more.
 *
 * A read and a wait are one agent's (`Asker`): the screen read for Codex says nothing of the Claude Code that runs in
 * the terminal once the read comes back. So the panes are asked for anew (`roster`) right before a read starts and
 * when it returns, and a wait whose agent is no longer the terminal's ends.
 */
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

export type WaitingKind = "permission" | "question" | null;
/** what one read found: the agent's asking (its kind and the card's own id), none (null), or nothing to go by (undefined) */
export type CardRead = { kind: WaitingKind; id: string } | null | undefined;

/** reads in a row that find no card before a wait ends, unless an answer went to the pane */
const EMPTY_READS_END = 2;
/** reads in a row that say nothing before a wait ends */
const FAILED_READS_END = 10;
const READS_AT_ONCE = 4;

/** the agent a read or a wait is for: its name, and its session where the pane says one */
interface Asker { readonly agent: string; readonly session: string | undefined }
interface Wait { readonly kind: WaitingKind; readonly id: string; asker: Asker; empty: number; failed: number }

function askerOf(pane: HerdrPane): Asker | null {
  return pane.agent ? { agent: pane.agent, session: pane.agent_session?.agent === pane.agent ? pane.agent_session.value : undefined } : null;
}
/** another name is another agent, and so is another session of it; a session not known on one side tells nothing */
function sameAsker(one: Asker, other: Asker): boolean {
  return one.agent === other.agent && (one.session === undefined || other.session === undefined || one.session === other.session);
}

export class CardWaits {
  private readonly waits = new Map<string, Wait>();
  /** panes a card's answer went to since their last read that found no card */
  private readonly answered = new Set<string>();
  /** panes picked for a read under way or still queued, that still count, and whom each read is for: forgetting a pane drops its read (ticks never overlap: the caller runs one at a time) */
  private readonly reading = new Map<string, Asker>();

  constructor(
    private readonly read: (pane: HerdrPane, panes: HerdrPane[]) => Promise<CardRead>,
    /** a wait began (true) or ended (false) */
    private readonly changed: (paneId: string, waiting: boolean) => void,
  ) {}

  waiting(paneId: string): boolean {
    return this.waits.has(paneId);
  }

  kindOf(paneId: string): WaitingKind | undefined {
    return this.waits.get(paneId)?.kind;
  }

  /**
   * An answer went to the pane's card `cardId`: where that card is the one waited on, its next read that finds no card
   * ends the wait. An answer that settled only after the next card came is not that card's.
   */
  answer(paneId: string, cardId: string): void {
    if (this.waits.get(paneId)?.id === cardId) this.answered.add(paneId);
  }

  /** The pane is gone, or what is reported next tells its status: what it waited on goes, told to nobody. */
  forget(paneId: string): void {
    this.waits.delete(paneId);
    this.answered.delete(paneId);
    this.reading.delete(paneId);
  }

  /**
   * One read of each pane of `roster` that `reads` picks (`only`: of those panes alone), and of each pane that waits. A
   * pane no longer listed is forgotten, and a waiting pane ends its wait once no agent runs in it, another one does, or
   * a tracker of its own tells its status (`owned`). Such a pane is never read: not when it became one while it waited
   * its turn behind the panes read before it, and a read of it under way then counts for nothing.
   */
  async tick(roster: () => HerdrPane[], reads: (pane: HerdrPane) => boolean, owned: (paneId: string) => boolean = () => false, only?: ReadonlySet<string>): Promise<void> {
    const panes = roster();
    const listed = new Set(panes.map((pane) => pane.pane_id));
    for (const paneId of [...this.waits.keys()]) if (!listed.has(paneId)) this.forget(paneId);
    for (const pane of panes) {
      const wait = this.waits.get(pane.pane_id);
      if (!wait) continue;
      const asker = askerOf(pane);
      if (asker === null || owned(pane.pane_id) || !sameAsker(wait.asker, asker)) this.end(pane.pane_id);
      else if (wait.asker.session === undefined) wait.asker = asker;
    }
    const candidates = panes.flatMap((pane) => {
      const asker = askerOf(pane);
      return asker !== null && !owned(pane.pane_id) && (only === undefined || only.has(pane.pane_id)) && (this.waits.has(pane.pane_id) || reads(pane)) ? [{ pane, asker }] : [];
    });
    for (const { pane, asker } of candidates) this.reading.set(pane.pane_id, asker);
    /** the pane is still this read's: not forgotten since it was picked, and the same agent's, with no tracker of its own, as listed now */
    const still = (now: HerdrPane[], { pane, asker }: { pane: HerdrPane; asker: Asker }): boolean => {
      const current = now.find((shown) => shown.pane_id === pane.pane_id);
      const runs = current ? askerOf(current) : null;
      return this.reading.get(pane.pane_id) === asker && runs !== null && sameAsker(asker, runs) && !owned(pane.pane_id);
    };
    for (let at = 0; at < candidates.length; at += READS_AT_ONCE) {
      const picked = candidates.slice(at, at + READS_AT_ONCE);
      const before = roster();
      const batch = picked.filter((candidate) => still(before, candidate));
      const found = await Promise.all(batch.map(({ pane }) => this.read(pane, before).catch((): CardRead => undefined)));
      const after = roster();
      batch.forEach((candidate, index) => { if (still(after, candidate)) this.settle(candidate.pane.pane_id, candidate.asker, found[index]); });
      for (const { pane, asker } of picked) if (this.reading.get(pane.pane_id) === asker) this.reading.delete(pane.pane_id);
    }
  }

  private settle(paneId: string, asker: Asker, read: CardRead): void {
    const wait = this.waits.get(paneId);
    if (read === undefined) {
      if (wait && ++wait.failed >= FAILED_READS_END) this.end(paneId);
      return;
    }
    if (read === null) {
      if (!wait) return;
      wait.failed = 0;
      if (this.answered.has(paneId) || ++wait.empty >= EMPTY_READS_END) this.end(paneId);
      return;
    }
    if (wait?.id === read.id) {
      wait.empty = 0;
      wait.failed = 0;
      return;
    }
    // another card where one was waited on (its answer brought the next asking before a read found the screen
    // without a card): that wait is over, an answer to it with it, and this card's begins
    if (wait) this.end(paneId);
    this.waits.set(paneId, { kind: read.kind, id: read.id, asker, empty: 0, failed: 0 });
    this.changed(paneId, true);
  }

  private end(paneId: string): void {
    this.waits.delete(paneId);
    this.answered.delete(paneId);
    this.changed(paneId, false);
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
