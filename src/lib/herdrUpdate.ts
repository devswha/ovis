import { useCallback, useEffect, useRef, useState } from "react";
import type { HerdrUpdateStatus } from "../../shared/update.ts";
import { fetchHerdrUpdate, requestHerdrUpdate } from "./api.ts";
import { usePageVisible } from "./visibility.ts";

export function useHerdrUpdate(enabled: boolean) {
  const [status, setStatus] = useState<HerdrUpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const visible = usePageVisible();
  useEffect(() => {
    if (!enabled) { setStatus(null); setPending(false); setError(null); return; }
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      let delay = 15_000;
      try {
        const next = await fetchHerdrUpdate();
        if (!stopped) setStatus((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        if (next.phase === "updating") delay = 1_500;
      } catch {}
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [enabled, refresh, visible]);

  const request = useCallback(async () => {
    setPending(true); setError(null);
    try {
      await requestHerdrUpdate();
      if (mounted.current) {
        setStatus((previous) => previous ? { ...previous, phase: "updating", output: null } : previous);
        setRefresh((value) => value + 1);
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally { if (mounted.current) setPending(false); }
  }, []);
  const busy = pending || status?.phase === "updating";
  return { status, error, busy, request };
}
