import { afterAll, beforeAll, expect, it, jest } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

/**
 * A file opened while a closed phone sheet's step back is still on its way: the browser lands that step
 * on the entry under the sheet, an older one than the file's, and the sheet module pushes the file's
 * entry again there (lib/sheetHistory.ts). The popstate still carries the older entry's state, which the
 * viewer must not show: the file it opened stays.
 */
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const entries: Array<{ state: unknown; href: string }> = [{ state: { pane: "a" }, href: "/?pane=a" }];
let index = 0;
const events = new EventTarget();
/** a browser that runs a traversal later, toward the entry it named when called */
const traverse = (by: number): void => {
  const next = index + by;
  setTimeout(() => {
    index = Math.max(0, Math.min(next, entries.length - 1));
    events.dispatchEvent(Object.assign(new Event("popstate"), { state: entries[index]!.state }));
  }, 1);
};
const history = {
  get state() { return entries[index]!.state; },
  pushState(state: unknown, _title: string, url?: string | null) { entries.splice(index + 1); entries.push({ state, href: url ?? entries[index]!.href }); index += 1; },
  replaceState(state: unknown, _title: string, url?: string | null) { entries[index] = { state, href: url ?? entries[index]!.href }; },
  back: () => traverse(-1), forward: () => traverse(1), go: traverse,
};
let sheetHistory: typeof import("./sheetHistory.ts");
let viewer: typeof import("./useFileViewer.ts");

beforeAll(async () => {
  for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: {
    history,
    get location() { return { href: entries[index]!.href }; },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } });
  // an instance of its own, on this browser: it patches the history it finds as it loads, as in the app
  const sheetPath = "./sheetHistory.ts?file-viewer-late-step";
  sheetHistory = await import(sheetPath);
  viewer = await import("./useFileViewer.ts");
});

afterAll(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

it("keeps a file opened while a closed sheet's step back was on its way, and Back still closes it", async () => {
  jest.useFakeTimers();
  let shown: ReturnType<typeof viewer.useFileViewer> | undefined;
  let renderer: ReactTestRenderer | undefined;
  function Probe() { shown = viewer.useFileViewer(); return null; }
  try {
    await act(async () => { renderer = create(createElement(Probe)); });
    const id = sheetHistory.enterSheet(() => undefined, null);
    sheetHistory.leaveSheet(id);
    // the sheet's step back is asked for, and the browser has not run it yet
    jest.advanceTimersByTime(0);
    const file = { path: "/r/README.md", machineId: "local", paneId: "p" };
    await act(async () => { shown!.openFile(file); });
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(shown!.viewing).toEqual(file);
    expect(history.state).toMatchObject({ "ovis:file-preview": file });
    expect(entries.length).toBe(index + 1);
    // the file's entry lies right over the pane's: its own close is one step back
    await act(async () => { shown!.closeFile(); });
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(shown!.viewing).toBeNull();
    expect(history.state).toMatchObject({ pane: "a" });
  } finally {
    await act(async () => { renderer?.unmount(); });
    jest.useRealTimers();
  }
});
