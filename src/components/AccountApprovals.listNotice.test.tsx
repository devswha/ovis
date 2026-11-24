import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AllowRefusal } from "../lib/account/listAllow.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ListAllowNotice } from "./AccountApprovals.tsx";

function render(why: AllowRefusal, retryAfterMs: number | null = null): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, null, createElement(ListAllowNotice, { stalled: { device: "Dana's tablet", pc: "Desk", why, retryAfterMs, retry: async () => {} }, onClose: () => {} })));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("a device a PC let in that the account's list did not take", () => {
  it("says where the device is, why it is not in the account, and offers to try again", () => {
    const html = render("not_claimed");
    expect(html).toContain("Dana&#x27;s tablet was added to Desk only");
    expect(html).toContain("Update Ovis on that device and sign in there, then try again.");
    expect(html).toContain("Try again");
    expect(html).toContain("Close");
    expect(html).toContain('data-why="not_claimed"');
  });

  it("says each reason in its own words, and never offers to try again for a device the list put out", () => {
    expect(render("stopped")).toContain("The account service cannot change the list right now.");
    expect(render("budget")).toContain("Too many devices were added just now. Try again in a few minutes.");
    for (const why of ["busy", "refused", "unreached"] as const) expect(render(why)).toContain("It could not be added to your account. Try again.");
    const removed = render("removed");
    expect(removed).toContain("That device was removed from your account. Sign in again on it first.");
    expect(removed).not.toContain(">Try again<");
  });

  it("never says the device was added to this PC only while that is not known: after an answer that never came, it says so and offers to check", () => {
    const html = render("unknown");
    expect(html).not.toContain("was added to Desk only");
    expect(html).toContain("Not known yet: is Dana&#x27;s tablet in your account?");
    expect(html).toContain("The account service did not answer. Try again to check.");
    expect(html).toContain(">Try again<");
  });

  it("says that the clock looks wrong, that this device cannot change the list, and how long a budget lasts", () => {
    expect(render("clock")).toContain("This device&#x27;s clock looks wrong. Check its date and time, then try again.");
    expect(render("blocked")).toContain("This device cannot change your account&#x27;s list right now.");
    // a device that is behind signs nobody in until it is updated
    expect(render("behind")).toContain("Update Ovis on this device, then try again.");
    expect(render("budget", 20 * 3600_000)).toContain("Too many devices were added. Try again tomorrow.");
    expect(render("budget", 5 * 60_000)).toContain("Too many devices were added just now. Try again in a few minutes.");
  });
});
