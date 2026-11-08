/**
 * Signing in from a button outside Settings (the relay tab of Add a connection): the sign-in starts
 * on the Ovis link page (deviceSignIn.ts, startLinkPageSignIn) in a new tab, with its code filled in,
 * and this page waits for it there. The tab is opened blank in the click itself, so no popup blocker
 * takes it, and pointed at the page once the service named it; in the desktop app that blank window
 * hands the page to the system browser (app/electron/src/main.ts, guard). A blocked tab leaves the
 * page and its code to open from here. Unmounting ends a sign-in still waiting, as Settings' does.
 * A sent tab stays open (no opener by design); after cancellation its old code never completes here.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { deviceLabel, deviceOs } from "../phone.ts";
import { startDeviceSignIn, startLinkPageSignIn, type DeviceSignIn } from "./deviceSignIn.ts";
import { offeredProviders } from "./service.ts";
import { indexedAccountStore, type AccountSession } from "./store.ts";

export type LinkPageSignInState =
  | { kind: "idle" }
  | { kind: "starting" }
  /** `opened`: the page is in a tab of its own; false, the browser blocked it and only this page shows it */
  | { kind: "waiting"; started: Pick<DeviceSignIn, "provider" | "userCode" | "verificationUri" | "verificationUriComplete">; opened: boolean }
  | { kind: "signed-in"; session: AccountSession }
  | { kind: "failed"; error: unknown };

export function useLinkPageSignIn(service: string, onSignedIn: (session: AccountSession) => void): { state: LinkPageSignInState; start: () => void; cancel: () => void } {
  const [state, setState] = useState<LinkPageSignInState>({ kind: "idle" });
  const running = useRef<AbortController | null>(null);
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;
  useEffect(() => () => running.current?.abort(), []);

  const cancel = useCallback(() => {
    running.current?.abort();
    running.current = null;
    setState({ kind: "idle" });
  }, []);

  const start = useCallback(() => {
    running.current?.abort();
    // in the click, before anything is awaited: a tab opened later is a popup the browser blocks
    const tab = window.open("about:blank", "_blank");
    // the sign-in page gets no handle on this one
    if (tab !== null) tab.opener = null;
    const controller = new AbortController();
    let sent = false;
    controller.signal.addEventListener("abort", () => { if (!sent) tab?.close(); }, { once: true });
    running.current = controller;
    setState({ kind: "starting" });
    void (async () => {
      const requester = { label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0), os: deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0) };
      // As in Settings, discovery supplies GitHub only when the service's offer is unknown.
      const offer = await offeredProviders(service, ["github"]);
      controller.signal.throwIfAborted();
      const options = { service, store: indexedAccountStore, requester };
      const fallback = offer.device[0];
      const started = fallback === undefined
        ? await startDeviceSignIn({ ...options, provider: "ovis" })
        : await startLinkPageSignIn(options, fallback);
      controller.signal.throwIfAborted();
      if (tab !== null) tab.location.href = started.verificationUriComplete ?? started.verificationUri;
      sent = true;
      setState({ kind: "waiting", started, opened: tab !== null });
      const session = await started.finish(controller.signal);
      controller.signal.throwIfAborted();
      // The account re-read may unmount us inside the callback; a finished page stays open.
      running.current = null;
      setState({ kind: "signed-in", session });
      signedIn.current(session);
    })().catch((error: unknown) => {
      // cancelled, or the sheet closed: it already moved on
      if (controller.signal.aborted) return;
      if (!sent) tab?.close();
      console.warn("Ovis: the sign-in did not finish", error instanceof Error ? error.name : error);
      setState({ kind: "failed", error });
    }).finally(() => { if (running.current === controller) running.current = null; });
  }, [service]);

  return { state, start, cancel };
}
