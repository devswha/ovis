import { useEffect, useState } from "react";
import { Clock } from "lucide-react";

import { WAITING_HINT_MS } from "../lib/sentWaiting.ts";

/** The clock a send's row shows when its turn takes longer than WAITING_HINT_MS, as SentWaitingList does. */
export function SendLate({ at, label }: { at: number; label: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (now - at >= WAITING_HINT_MS) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, at + WAITING_HINT_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [at, now]);
  if (now - at < WAITING_HINT_MS) return null;
  return <span className="chat-sent-late" role="img" aria-label={label} title={label}><Clock aria-hidden="true" /></span>;
}
