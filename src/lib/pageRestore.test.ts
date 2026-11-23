import { describe, expect, it } from "bun:test";
import { PAGE_LEAVING_EVENT } from "./paneLifetime.ts";
import { reloadRestoredAppPage } from "./pageRestore.ts";

/** a page whose loads, and the events it was sent before them, are written down */
function page() {
  const target = new EventTarget();
  const seen: string[] = [];
  target.addEventListener(PAGE_LEAVING_EVENT, () => seen.push("leaving"));
  return {
    seen,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    location: { reload: () => { seen.push("reload"); } },
    show: (persisted: boolean) => target.dispatchEvent(Object.assign(new Event("pageshow"), { persisted })),
  };
}

describe("a page the browser brings back from its back/forward cache", () => {
  it("loads again in the phone app, after handing what it holds in memory alone to storage", () => {
    const shown = page();
    reloadRestoredAppPage(shown, () => true);
    shown.show(false);
    expect(shown.seen).toEqual([]);
    shown.show(true);
    expect(shown.seen).toEqual(["leaving", "reload"]);
  });

  it("is left to reconnect in place in a browser", () => {
    const shown = page();
    reloadRestoredAppPage(shown, () => false);
    shown.show(true);
    expect(shown.seen).toEqual([]);
  });
});
