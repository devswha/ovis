import type { MyPc, MyPcState } from "../account/myPcs.ts";
import { REGIONAL_RELAYS } from "../../../shared/relay-regions.ts";

export type DashboardPc = MyPc & { relay: string | null };

export function dashboardModel(pcs: readonly DashboardPc[], me: { label: string }, defaultRelay: string) {
  const relays = new Map<string, string[]>();
  const hubs = new Map<string, DashboardPc[]>();
  const counts = { ready: 0, needsYou: 0, offline: 0 };
  const attention: { server_id: string; reason: MyPcState }[] = [];

  for (const pc of pcs) {
    if (pc.state === "paired") counts.ready++;
    else if (pc.state === "offline") counts.offline++;
    else counts.needsYou++;

    if (pc.state !== "paired") attention.push({ server_id: pc.server_id, reason: pc.state });

    const origin = pc.relay ?? defaultRelay;
    const relayPcs = relays.get(origin) ?? [];
    relayPcs.push(pc.server_id);
    relays.set(origin, relayPcs);

    const hubPcs = hubs.get(origin) ?? [];
    hubPcs.push(pc);
    hubs.set(origin, hubPcs);
  }

  return {
    counts,
    relays: [...relays].map(([origin, ids]) => ({ origin, regional: REGIONAL_RELAYS.includes(origin), pcs: ids })),
    attention,
    map: {
      me: { label: me.label },
      hubs: [...hubs]
        .sort(([a, pcsA], [b, pcsB]) => pcsB.length - pcsA.length || a.localeCompare(b))
        .map(([origin, members]) => ({
          origin,
          nodes: members.map((pc) => ({
            server_id: pc.server_id,
            name: pc.name,
            state: pc.state,
            seen: pc.state === "offline" ? "stale" as const
              : pc.state === "paired" && pc.last_seen_at !== null ? "lately" as const : "unknown" as const,
          })),
        })),
    },
  };
}
