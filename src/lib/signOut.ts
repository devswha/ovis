import type { HealthAuth } from "../../shared/protocol.ts";
import { fetchBridgeHealth, signOut, signOutOfPortal } from "./api.ts";

export function canSignOut(auth: HealthAuth | null): boolean {
  if (auth?.authenticated !== true) return false;
  return auth.via === "device" || auth.via === "portal" || (auth.via === "token" && auth.bearer !== true);
}

/**
 * Ends this browser's sign-in the way it got in, and says whether the page must reload to show
 * what follows: Portal answers every request without its session with its own sign-in page, so
 * a browser Portal signed in loads that; the others ask the app, which then shows its own gate.
 */
export async function endSignIn(via: HealthAuth["via"]): Promise<{ reload: boolean }> {
  if (via !== "portal") {
    await signOut();
    if ((await fetchBridgeHealth()).auth.via !== "portal") return { reload: false };
  }
  await signOutOfPortal();
  return { reload: true };
}
