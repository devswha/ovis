import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import type { PiVoiceState } from "../lib/piVoiceSession.ts";
import { PiVoiceFloat } from "./PiVoiceView.tsx";

const live: PiVoiceState = {
  status: "live", machineId: "local", paneId: "w1:p1", label: "api", phase: "listening", muted: false, assistantText: "", usage: null, end: null,
};

// the settings read the browser's languages to pick English
const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
beforeAll(() => Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] }));
afterAll(() => {
  if (languages) Object.defineProperty(navigator, "languages", languages);
  else Reflect.deleteProperty(navigator, "languages");
});

function render(voice: Partial<PiVoiceState>): string {
  return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PiVoiceFloat, { voice: { ...live, ...voice } }) }));
}

describe("the call's orb", () => {
  test("names the pane the call is on, and shows the billed time as m:ss once Pi says it", () => {
    expect(render({})).toContain("Call controls · api");
    expect(render({})).not.toContain("pi-voice-float-usage");
    expect(render({ usage: 75 })).toContain(">1:15</span>");
  });

  test("a parked call sleeps: a note that stays, End in reach and no Mute", () => {
    const markup = render({ phase: "parked", usage: 600 });
    expect(markup).toContain("is-parked");
    expect(markup).toContain("Talk now · api");
    expect(markup).toContain("Task running. The voice returns with the result.");
    expect(markup).toContain('aria-label="End call"');
    expect(markup).not.toContain('aria-label="Mute"');
    expect(markup).toContain(">10:00</span>");
    // the controls are reachable, not inert as they are on a live call until the orb is tapped
    expect(markup).not.toContain("inert");
    expect(render({})).toContain("inert");
  });

  test("a call that stopped says why on the dimmed orb", () => {
    const markup = render({ status: "ended", phase: "connecting", end: { kind: "closed" } });
    expect(markup).toContain("is-ended");
    expect(markup).toContain("The call was cut off.");
    expect(markup).not.toContain("is-parked");
  });
});
