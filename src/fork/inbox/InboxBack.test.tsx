import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "../../lib/settings.ts";
import { ForkInboxBack } from "./InboxBack.tsx";

const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null,
  } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  for (const [key, value] of saved) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function settings(agentFriends: boolean, language = "en") {
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    localStorage: { getItem: (key: string) => key === "ovis:settings" ? JSON.stringify({ agentFriends, language }) : null, setItem() {} },
  } });
}
const draw = (wide: boolean) => renderToStaticMarkup(<SettingsProvider><ForkInboxBack wide={wide} onBack={() => {}}><span>Upstream brand</span></ForkInboxBack></SettingsProvider>);

test("keeps upstream branding with Agent friends off", () => {
  settings(false);
  expect(draw(true)).toBe("<span>Upstream brand</span>");
  expect(draw(false)).toBe("<span>Upstream brand</span>");
});

test("phone inbox home draws neither a logo nor a misleading back arrow", () => {
  settings(true);
  expect(draw(false)).toBe("");
});

test("desktop inbox draws an accessible Back arrow, translated by fork i18n", () => {
  settings(true);
  const out = draw(true);
  expect(out).toContain('aria-label="Back"');
  expect(out).toContain('title="Back"');
  expect(out).toContain("lucide-arrow-left");
  expect(out).not.toContain("Upstream brand");
  settings(true, "ja");
  expect(draw(true)).toContain('aria-label="戻る"');
});

test("Back invokes the supplied inbox-exit action and preserves rail classes", async () => {
  settings(true);
  let exited = 0;
  await act(async () => { renderer = create(<SettingsProvider><ForkInboxBack wide onBack={() => { exited++; }} className="inbox-rail-item inbox-rail-exit" /></SettingsProvider>); });
  const back = renderer!.root.findByType("button");
  expect(back.props.className).toContain("inbox-rail-exit");
  await act(async () => { back.props.onClick(); });
  expect(exited).toBe(1);
});
