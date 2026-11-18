/**
 * Who looks at what: the pane a person has in front of them, which the screen tells every Herdr client by raising
 * `herdr.seen` (server/herdr-core/seen-label.ts), and the alerts an agent's change of state gives. Pure: the caller
 * gathers the facts, and keeps what changes between two calls.
 */
import type { CoreChange } from "../../server/herdr-core/core-model.ts";
import type { AgentStatus } from "../../shared/herdr-api.generated.ts";

/** What the screen knows at one moment of the pane it shows and of the person in front of it. */
export interface LookState {
  /** the host's focus as it last reported it; null: it never reported any */
  readonly hostFocused: boolean | null;
  /** an input event (a key, text, a paste, a click) was read after the shown pane's last turn ended */
  readonly inputAfterTurn: boolean;
  /** the focused pane of the shown tab; null: none */
  readonly pane: string | null;
  /** that pane is Live: its first paint is complete and drawn */
  readonly live: boolean;
  /** that pane was drawn in the last frame the host took */
  readonly drawn: boolean;
  /** an overlay (help, a dialog, the menu, the agent list) covers the panes */
  readonly overlay: boolean;
  /** the core's line is up */
  readonly online: boolean;
}

/**
 * The pane a person looks at, or null. A person is there while the host reports focus in; on a host that never
 * reports focus, an input event read after the pane's last turn is the proof. The pane is the focused one of the
 * shown tab (never another pane of a split), Live, drawn in the last frame, with no overlay over it, on a line that is up.
 */
export function look(state: LookState): string | null {
  const present = state.hostFocused ?? state.inputAfterTurn;
  return present && state.pane !== null && state.live && state.drawn && !state.overlay && state.online ? state.pane : null;
}

/** An agent's change of state the person is told of: it needs them, or it finished a turn while they looked elsewhere. */
export interface Alert { readonly terminal: string; readonly kind: "blocked" | "done" }

/**
 * The alerts in the change records the core model made of one hc event (`cause`, the event's type): a terminal shown
 * blocked that was not is "Needs you"; one shown done that was not, on the `turn` event that ended its turn, is "Done"
 * unless it is the pane looked at. `before` is what each terminal showed before the event. A snapshot (the first, a
 * `missed` one, one after a reconnect) gives no records and so no alert.
 */
export function alertsOf(cause: string, changes: readonly CoreChange[], before: (terminal: string) => AgentStatus | undefined, looked: string | null): Alert[] {
  const shown = new Map<string, AgentStatus | undefined>();
  const alerts: Alert[] = [];
  for (const change of changes) {
    if (change.type !== "status") continue;
    const was = shown.has(change.terminal) ? shown.get(change.terminal) : before(change.terminal);
    shown.set(change.terminal, change.shown);
    if (change.shown === was) continue;
    if (change.shown === "blocked") alerts.push({ terminal: change.terminal, kind: "blocked" });
    else if (change.shown === "done" && cause === "turn" && change.terminal !== looked) alerts.push({ terminal: change.terminal, kind: "done" });
  }
  return alerts;
}
