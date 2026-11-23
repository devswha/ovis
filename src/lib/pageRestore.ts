import { inNativeApp } from "./nativeApp.ts";
import { PAGE_LEAVING_EVENT } from "./paneLifetime.ts";

interface RestorablePage extends Pick<EventTarget, "addEventListener" | "dispatchEvent"> {
  readonly location: { reload(): void };
}

/**
 * A page WebKit kept whole in its back/forward cache and shows again (pageshow, persisted): in the phone app nothing it
 * waits on will come, whatever its sockets say, because Capacitor drops every native listener as a navigation starts
 * (WebViewDelegationHandler → CapacitorBridge.reset) and OvisDirect closes the page's direct sockets as it is left. So it
 * loads again, after handing what it holds in memory alone to storage as when the app replaces a page
 * (PAGE_LEAVING_EVENT): an unsent draft survives as across any reload. In a browser the transports reconnect in place
 * (lib/ws.ts, lib/relay/transport.ts).
 */
export function reloadRestoredAppPage(page: RestorablePage = window, native: () => boolean = inNativeApp): void {
  page.addEventListener("pageshow", (event) => {
    if ((event as { persisted?: unknown }).persisted !== true || !native()) return;
    page.dispatchEvent(new Event(PAGE_LEAVING_EVENT));
    page.location.reload();
  });
}
