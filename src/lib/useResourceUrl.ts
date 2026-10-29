import { useEffect, useMemo, useState } from "react";

import { getTransport, serverResourceUrl } from "./transport.ts";

/**
 * The address to give the browser for a server path (lib/transport.ts). The native transport
 * answers at once with the path itself; a transport that answers later leaves it null meanwhile.
 * data:, blob: and other origins' URLs come back as they are.
 */
export function useResourceUrl(path: string | null): string | null {
  const transport = getTransport();
  const target = useMemo(() => path === null ? null : serverResourceUrl(path, transport), [path, transport]);
  const [resolved, setResolved] = useState<{ target: Promise<string>; url: string } | null>(null);
  useEffect(() => {
    if (target === null || typeof target === "string") return;
    let live = true;
    // a refusal is left unhandled, so the browser reports it; the address stays null
    void target.then((url) => { if (live) setResolved({ target, url }); });
    return () => { live = false; };
  }, [target]);
  if (target === null || typeof target === "string") return target;
  return resolved?.target === target ? resolved.url : null;
}
