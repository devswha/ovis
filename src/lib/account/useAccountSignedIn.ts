import { useEffect, useState } from "react";
import { indexedAccountStore } from "./store.ts";

export function useAccountSignedIn(): string | null {
  const [signedIn, setSignedIn] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    indexedAccountStore.get("session").then((session) => { if (live) setSignedIn(session?.account ?? null); }, () => undefined);
    return () => { live = false; };
  }, []);
  return signedIn;
}
