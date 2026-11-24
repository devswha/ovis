/** The authorized machine event document, shared by SSE and the terminal WebSocket. */
import type { DevicePairedEvent, DevicePairedSeenEvent, DeviceRemovedEvent, PendingRedemptionsEvent, Machine, MachineEvent, RelayPairingsEvent, RemotePairingsEvent } from "../shared/machines.ts";
import type { AgentRowTokens } from "../shared/pane-tokens.ts";
import type { SharedPreferences } from "../shared/preferences.ts";
import type { SeenFinish } from "../shared/seen.ts";
import type { OmarchyTheme } from "../shared/omarchy-theme.ts";
import type { hiddenEvents } from "./hidden-events.ts";
import type { MachineManager } from "./machines.ts";
import { decidedRowTokens, reportedTokenValues, snapshotWithoutHiddenTokens, withoutHiddenTokens } from "./herdr-sidebar.ts";

export interface MachineEventDocument {
  manager: Pick<MachineManager, "subscribe">;
  preferences?: { get(): SharedPreferences; subscribe(listener: (preferences: SharedPreferences) => void): () => void };
  herdrSidebar?: { get(): AgentRowTokens | null; subscribe(listener: (agents: AgentRowTokens | null) => void): () => void };
  seen?: { list(): SeenFinish[]; subscribe(listener: (finish: SeenFinish) => void): () => void };
  /** Filtered for the authenticated device and browser at the transport's admission boundary. */
  pairings?: { subscribe(listener: (event: DevicePairedEvent | DevicePairedSeenEvent | DeviceRemovedEvent | RelayPairingsEvent | RemotePairingsEvent | PendingRedemptionsEvent) => void): () => void };
  /** Bound to this browser's device address at admission, never another PC's theme. */
  omarchyTheme?: { get(): OmarchyTheme | null; subscribe(listener: (theme: OmarchyTheme | null) => void): () => void };
  /** Bound to this browser's device address at admission: POST /api/machines/open reaches only the windows on the device that asks. */
  open?: { subscribe(listener: (event: MachineEvent) => void): () => void };
  /** A page nobody sees takes only what an in-app alert reads (server/hidden-events.ts). */
  hidden?: ReturnType<typeof hiddenEvents>;
}

/** Initial documents and subsequent invalidations use exactly the same redaction on either transport. */
export function subscribeMachineEvents({ manager, preferences, herdrSidebar, seen, pairings, omarchyTheme, open, hidden }: MachineEventDocument, send: (event: MachineEvent) => void): () => void {
  const stops: Array<() => void> = [];
  let active = true;
  let lastRoster: string | null = null;
  const tell = (event: MachineEvent) => { if (active) { lastRoster = null; send(event); } };
  const stop = () => { active = false; for (const off of stops.splice(0)) off(); };
  try {
    let rows = herdrSidebar?.get() ?? null;
    let reported = new Map<string, Set<string>>();
    let roster: Machine[] | undefined;
    let toldSidebar: string | undefined;
    const sendSidebar = (...values: Map<string, Set<string>>[]) => {
      if (!herdrSidebar) return;
      const event = { type: "herdr-sidebar", agents: decidedRowTokens(rows, ...values) } satisfies MachineEvent;
      const encoded = JSON.stringify(event);
      if (encoded === toldSidebar) return;
      toldSidebar = encoded;
      tell(event);
    };
    const sendRoster = (machines: Machine[], force = false) => {
      roster = machines;
      if (hidden && !hidden.sendsRoster(machines, force)) return;
      const shown = withoutHiddenTokens(rows, machines);
      const incoming = reportedTokenValues(shown);
      sendSidebar(reported, incoming);
      reported = incoming;
      const encoded = JSON.stringify(shown);
      if (encoded === lastRoster) return;
      tell({ type: "machines", machines: shown });
      lastRoster = encoded;
    };
    stops.push(manager.subscribe((event) => {
      if (event.type === "machines") { sendRoster(event.machines); return; }
      if (hidden && !hidden.sendsMessage(event)) return;
      tell(event.type === "machine-message" && event.message.type === "snapshot"
        ? { ...event, message: { ...event.message, snapshot: snapshotWithoutHiddenTokens(rows, event.message.snapshot) } }
        : event);
    }));
    const sendPreferences = (shared: SharedPreferences) => tell({ type: "preferences", preferences: shared });
    if (preferences) {
      stops.push(preferences.subscribe(sendPreferences));
      sendPreferences(preferences.get());
    }
    sendSidebar(reported);
    if (herdrSidebar) stops.push(herdrSidebar.subscribe((next) => { rows = next; if (roster) sendRoster(roster, true); else sendSidebar(reported); }));
    if (seen) {
      tell({ type: "seen", finishes: seen.list() });
      stops.push(seen.subscribe((finish) => tell({ type: "seen", finishes: [finish] })));
    }
    if (omarchyTheme) {
      const sendTheme = (theme: OmarchyTheme | null) => tell({ type: "omarchy-theme", theme });
      stops.push(omarchyTheme.subscribe(sendTheme));
      sendTheme(omarchyTheme.get());
    }
    if (pairings) stops.push(pairings.subscribe(tell));
    if (open) stops.push(open.subscribe(tell));
    return stop;
  } catch (error) { stop(); throw error; }
}
