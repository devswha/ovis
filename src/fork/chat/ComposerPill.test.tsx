import { afterEach, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsProvider } from "../../lib/settings.ts";
import { useForkComposer } from "./ComposerPill.tsx";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function Pill({ role = "drive", working = false }: { role?: string; working?: boolean }) {
  const { renderPill } = useForkComposer({
    agent: "pi", role, connected: true, sending: false, isWorking: working, agentStatus: working ? "working" : "idle",
    metadata: { model: "custom", reasoning_effort: "high", models: [{ id: "provider/custom", name: "Provider model", window: 100000, levels: ["low", "high"], current: true }] },
    onCommand: () => true, onRefused: () => {},
  });
  return renderPill(<span className="composer-usage">Usage</span>);
}

function draw(enabled: boolean, props: { role?: string; working?: boolean } = {}) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: (key: string) => key === "ovis:settings" ? JSON.stringify({ piModelPicker: enabled, language: "en" }) : null } } });
  return renderToStaticMarkup(<SettingsProvider><Pill {...props} /></SettingsProvider>);
}

it("keeps the display-only upstream pill when disabled or observing", () => {
  for (const markup of [draw(false), draw(true, { role: "observe" })]) {
    expect(markup).toContain('class="composer-model is-id"');
    expect(markup).toContain('class="composer-usage"');
    expect(markup).not.toContain("composer-pill-menu");
  }
});

it("enables the Pi picker only while idle and keeps usage inside the pill", () => {
  const idle = draw(true);
  expect(idle).toContain("Provider model");
  expect(idle).toContain('aria-haspopup="menu"');
  expect(idle).not.toContain('disabled=""');
  expect(draw(true, { working: true })).toContain('disabled=""');
});
