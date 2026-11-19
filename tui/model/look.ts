/**
 * Who looks at what: the pane a person has in front of them, which the screen tells every Herdr client by raising
 * `herdr.seen` (server/herdr-core/seen-label.ts). Pure: the caller gathers the facts, and keeps what changes between two
 * calls.
 */

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
  /** an overlay (help, a dialog, the menu) covers the panes */
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
