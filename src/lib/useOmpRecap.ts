import { useEffect, useState } from "react";

import { useMachineApi } from "./machineContext.tsx";
import type { OmpRecap } from "../../shared/protocol.ts";

const POLL_MS = 10_000;
const READ_DEADLINE_MS = 10_000;

/**
 * The recap omp wrote while its user was away, for an OMP pane shown in Chat. omp saves it outside the
 * transcript, so it is read on a timer, as /btw is; a hidden page asks nothing and looks again on the next tick.
 */
export function useOmpRecap(paneId: string | null, enabled: boolean): OmpRecap | null {
  const { fetchPaneRecap } = useMachineApi();
  const [recap, setRecap] = useState<OmpRecap | null>(null);
  useEffect(() => {
    setRecap(null);
    if (paneId === null || !enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading: AbortController | undefined;
    const load = (): void => {
      const later = (): void => { if (alive) timer = setTimeout(load, POLL_MS); };
      if (document.visibilityState === "hidden") { later(); return; }
      const controller = reading = new AbortController();
      const deadline = setTimeout(() => controller.abort(), READ_DEADLINE_MS);
      fetchPaneRecap(paneId, controller.signal).then(
        (found) => { clearTimeout(deadline); if (alive) setRecap(found); later(); },
        () => { clearTimeout(deadline); later(); },
      );
    };
    load();
    return () => { alive = false; clearTimeout(timer); reading?.abort(); };
  }, [fetchPaneRecap, paneId, enabled]);
  return recap;
}
