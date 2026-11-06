import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AccountAsker as Asker } from "../../shared/account-asker.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AccountAsker } from "./AccountApprovalPrompt.tsx";

function render(asker: Asker, language: string): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, null, createElement(AccountAsker, { asker, language })));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

// The approval card's last line of defence against a phished device code (RFC 8628 section 5.4):
// what the account service saw of the device asking, so a request from a stranger looks like one.
describe("who is asking, on the approval card", () => {
  it("names the system the device sent and the place its request came from, in the app's language", () => {
    const html = render({ os: "ios", country: "KR", city: "Seoul" }, "en");
    expect(html).toContain("iOS");
    expect(html).toContain("Seoul, South Korea");
    expect(html).toContain('data-place="known"');
    expect(render({ os: null, country: "JP", city: null }, "ko")).toContain("일본");
  });

  it("says when the place is unknown instead of leaving it out", () => {
    const html = render({ os: "windows", country: null, city: null }, "en");
    expect(html).toContain("Windows");
    expect(html).toContain('data-place="unknown"');
  });
});
