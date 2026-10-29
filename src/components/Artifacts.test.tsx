import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { Artifacts } from "./Artifacts.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import type { ClaudeArtifact } from "../../shared/protocol.ts";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: {
      ...listen,
      localStorage: { getItem: () => null, setItem() {} },
      matchMedia: () => ({ ...listen, matches: false }),
    },
    document: { ...listen, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  });
  jest.useFakeTimers();
});

const pane = () => createElement(SettingsProvider, { children: createElement(Artifacts, { paneId: "fixture", status: "done" }) });

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  jest.useRealTimers();
  jest.restoreAllMocks();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("discovers published pages after an empty initial lookup without a status change", async () => {
  // The HTTP boundary answers empty until discovery completes; the component and machine API are real.
  let pages: ClaudeArtifact[] = [];
  jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ artifacts: pages }), globalThis.fetch));
  await act(async () => { renderer = create(pane()); });
  expect(renderer?.toJSON()).toBeNull();
  for (let attempt = 0; attempt < 4; attempt++) {
    await act(async () => { jest.runOnlyPendingTimers(); });
    expect(renderer?.toJSON()).toBeNull();
  }

  // Complete discovery, then explicitly fire the client's next scheduled lookup. No elapsed-time wait.
  pages = [{ url: "https://claude.ai/artifact/fixture", title: "Fixture", at: null }];
  await act(async () => { jest.runOnlyPendingTimers(); });
  expect(renderer?.root.findAllByType("button")).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
});

test("cancels an empty lookup's scheduled refresh when unmounted", async () => {
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ artifacts: [] }), globalThis.fetch));
  await act(async () => { renderer = create(pane()); });
  expect(jest.getTimerCount()).toBe(1);
  await act(async () => renderer?.unmount());
  const calls = fetch.mock.calls.length;
  await act(async () => { jest.runOnlyPendingTimers(); });
  expect(fetch.mock.calls).toHaveLength(calls);
  expect(jest.getTimerCount()).toBe(0);
});
