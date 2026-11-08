/**
 * Signing in from a button outside Settings (the relay tab of Add a connection): the sign-in starts
 * on the Ovis link page (deviceSignIn.ts, startLinkPageSignIn) in a new tab, with its code filled in,
 * and this page waits for it there. The tab is opened blank in the click itself, so no popup blocker
 * takes it, and pointed at the page once the service named it; in the desktop app that blank window
 * hands the page to the system browser (app/electron/src/main.ts, guard). A blocked tab leaves the
 * page and its code to open from here. Unmounting ends a sign-in still waiting, as Settings' does.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { deviceLabel, deviceOs } from "../phone.ts";
import { startLinkPageSignIn, type DeviceSignIn } from "./deviceSignIn.ts";
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
    running.current = controller;
    setState({ kind: "starting" });
    let sent = false;
    void (async () => {
      const requester = { label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0), os: deviceOs(navigator.userAgent, navigator.maxTouchPoints ?? 0) };
      // the link page busy or missing: GitHub's own device page, as Settings falls back to before it knows the service's list
      const started = await startLinkPageSignIn({ service, store: indexedAccountStore, requester }, "github");
      controller.signal.throwIfAborted();
      if (tab !== null) tab.location.href = started.verificationUriComplete ?? started.verificationUri;
      sent = true;
      setState({ kind: "waiting", started, opened: tab !== null });
      const session = await started.finish(controller.signal);
      setState({ kind: "signed-in", session });
      signedIn.current(session);
    })().catch((error: unknown) => {
      // a blank tab no page was sent to goes with the sign-in
      if (!sent) tab?.close();
      // cancelled, or the sheet closed: it already moved on
      if (controller.signal.aborted) return;
      console.warn("Ovis: the sign-in did not finish", error instanceof Error ? error.name : error);
      setState({ kind: "failed", error });
    }).finally(() => { if (running.current === controller) running.current = null; });
  }, [service]);

  return { state, start, cancel };
}
