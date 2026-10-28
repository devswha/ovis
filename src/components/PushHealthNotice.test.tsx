import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { dismissPushNotice, refreshPushHealth, resetPushHealth, runPushAction } from "../lib/pushHealth.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PushHealthNotice } from "./PushHealthNotice.tsx";

describe("the alerts notice", () => {
  const saved = { PushManager: (globalThis as { PushManager?: unknown }).PushManager, Notification: (globalThis as { Notification?: unknown }).Notification };
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  const render = () => renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PushHealthNotice, { onRepair: () => undefined, onOpen: () => undefined }) }));

  beforeEach(async () => {
    // alerts wanted and allowed, and the browser holds no subscription
    const pushManager = { getSubscription: async () => null };
    Object.defineProperty(globalThis.navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => ({ pushManager }) } });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    Object.assign(globalThis, { PushManager: class {}, Notification: { permission: "granted" } });
    resetPushHealth();
    await refreshPushHealth(true);
  });

  afterEach(() => {
    delete (globalThis.navigator as { serviceWorker?: unknown; brave?: unknown }).serviceWorker;
    delete (globalThis.navigator as { brave?: unknown }).brave;
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
    Object.assign(globalThis, saved);
    resetPushHealth();
  });

  it("says why a repair failed instead of asking for it again, and can be closed", async () => {
    expect(render()).toContain("This device&#x27;s push subscription is missing. Turn alerts on again.");
    expect(render()).toContain("aria-label=\"Dismiss\"");
    await runPushAction("repair", async () => ({ result: "refused" }), () => true);
    expect(render()).toContain("This device would not make a push subscription.");
    // in Brave, the setting that turns its push service on
    Object.defineProperty(globalThis.navigator, "brave", { configurable: true, value: {} });
    expect(render()).toContain("Turn on Use Google services for push messaging in Brave&#x27;s privacy settings");
    await runPushAction("repair", async () => ({ result: "no-worker" }), () => true);
    expect(render()).toContain("Reload the page, then try again.");
    // the repair stays on offer: a reload or a changed setting may let it through
    expect(render()).toContain("Turn alerts on again");
    dismissPushNotice();
    expect(render()).toBe("");
  });
});
