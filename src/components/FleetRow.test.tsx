import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { FleetRow } from "./FleetRow.tsx";

/** English, whatever the machine running the test prefers. */
function render(preview: boolean): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(FleetRow, { preview, onOpen: () => undefined }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("Settings' entry to the Fleet screen (OVIS_PREVIEW=fleet)", () => {
  it("draws nothing while the server's health does not say fleet_preview", () => {
    expect(render(false)).toBe("");
  });

  it("draws its one Open fleet button while the health says fleet_preview", () => {
    const html = render(true);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain(">Open fleet</button>");
  });
});
