import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AllowRefusal } from "../lib/account/listAllow.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ListAllowNotice } from "./AccountApprovals.tsx";

function render(why: AllowRefusal): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, null, createElement(ListAllowNotice, { stalled: { device: "Dana's tablet", pc: "Desk", why, retry: async () => {} }, onClose: () => {} })));
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
});
