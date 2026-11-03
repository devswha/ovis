import type { Machine, MachineEvent } from "../shared/machines.ts";

/** How often a stream for a page nobody sees is kept warm, once a minute instead of every 15 seconds. */
export const HIDDEN_HEARTBEAT_MS = 60_000;

/**
 * What a page nobody sees (a phone app in the background, the screen off) takes from the machine events
 * (`/api/machines/events?hidden=1`): the app posts its in-app alerts itself, so it needs a pane's status
 * and exit, and a roster only when a PC or a pane comes or goes. Every other roster is the same sidebar
 * with a title or a timestamp moved, 9 KB or more each time, and the page loads a fresh one on return.
 */
export function hiddenEvents() {
  let toldShape: string | undefined;
  return {
    /** The first roster always goes (an alert needs the pane it names); later ones when `rosterShape` moved, or when `force`d. */
    sendsRoster(machines: Machine[], force = false): boolean {
      const shape = rosterShape(machines);
      if (!force && shape === toldShape) return false;
      toldShape = shape;
      return true;
    },
    /** A PC's own message goes when an alert reads it; focus, layout and snapshots wait for the page to be shown. */
    sendsMessage(event: MachineEvent): boolean {
      return event.type !== "machine-message" || event.message.type === "pane-status" || event.message.type === "pane-exited";
    },
  };
}

/** The part of a roster an alert can miss: which PCs there are in which state, and which panes each one holds. */
export function rosterShape(machines: Machine[]): string {
  return JSON.stringify(machines.map((machine) => [
    machine.id, machine.state, machine.enabled, machine.error, machine.action_required ?? null, machine.tailnet_offline ?? false,
    machine.snapshot?.panes.map((pane) => pane.pane_id) ?? null,
  ]));
}
