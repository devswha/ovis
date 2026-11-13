import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { NAV_KEY } from "./deepLink.ts";
import { useInboxMode, type InboxMode } from "./inboxMode.ts";

describe("useInboxMode", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let mode: InboxMode;
  /** every history write: the method, the entry it was made on and the address it left there */
  let writes: string[];
  let entries: Array<{ state: unknown; url: URL }>;
  let index: number;
  let listeners: Array<(event: Event) => void>;
  /** what a listener registered after the hook's saw of each pop: the event must reach it */
  let heardAfter: number;

  beforeEach(() => {
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    writes = [];
    listeners = [];
    heardAfter = 0;
    const write = (method: "pushState" | "replaceState") => (state: unknown, _unused: string, url?: string): void => {
      const entry = { state, url: url === undefined ? entries[index]!.url : new URL(url, entries[index]!.url) };
      if (method === "pushState") { entries.splice(index + 1); entries.push(entry); index += 1; } else entries[index] = entry;
      writes.push(`${method} ${index} ${entry.url.search}${entry.url.hash}`);
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      get location() { return entries[index]!.url; },
      history: {
        get state() { return entries[index]!.state; },
        pushState: write("pushState"), replaceState: write("replaceState"),
        go: (steps: number): void => {
          index += steps;
          let stopped = false;
          const event = Object.assign(new Event("popstate"), { state: entries[index]!.state, stopImmediatePropagation: () => { stopped = true; } });
          for (const listener of [...listeners]) { if (!stopped) listener(event); }
        },
      },
      addEventListener: (_type: "popstate", listener: (event: Event) => void) => { listeners.push(listener); },
      removeEventListener: (_type: "popstate", listener: (event: Event) => void) => { listeners = listeners.filter((other) => other !== listener); },
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function mount(addresses: string[], read = true): Promise<void> {
    entries = addresses.map((address) => ({ state: null, url: new URL(`http://localhost:7317${address}`) }));
    index = entries.length - 1;
    function Probe() { mode = useInboxMode({ read }); return null; }
    await act(async () => { renderer = create(createElement(Probe)); });
    window.addEventListener("popstate", () => { heardAfter += 1; });
    writes = [];
  }
  const back = (): Promise<void> => act(async () => { window.history.go(-1); });
  const forward = (): Promise<void> => act(async () => { window.history.go(1); });
  const searches = (): string[] => entries.map((entry) => entry.url.search);

  it("is off on the app's own address and on on the mode's, writing nothing at load", async () => {
    await mount(["/?ws=w1-api&pane=p1&view=chat"]);
    expect([mode.on, mode.at()]).toEqual([false, false]);
    expect(writes).toEqual([]);
    await act(async () => { renderer?.unmount(); });

    // opened by its own address, or reloaded there: the mode, with nothing of the app pushed under or over it
    await mount(["/?app=inbox"]);
    expect([mode.on, mode.at()]).toEqual([true, true]);
    expect(writes).toEqual([]);
    expect(entries).toHaveLength(1);
  });

  it("enters by one entry that keeps the address's other parameters, and Back and Forward follow it", async () => {
    await mount(["/?ws=w1-api&pane=p1&view=chat"]);

    await act(async () => { mode.enter(); });
    expect(mode.on).toBe(true);
    expect(writes).toEqual(["pushState 1 ?ws=w1-api&pane=p1&view=chat&app=inbox"]);
    expect(entries[1]!.state).toEqual({ [NAV_KEY]: true });

    await back();
    expect([mode.on, mode.at()]).toEqual([false, false]);
    await forward();
    expect([mode.on, mode.at()]).toEqual([true, true]);
    expect(writes).toHaveLength(1);
    expect(heardAfter).toBe(2);
  });

  it("leaves by one entry, and Back returns to the mode", async () => {
    await mount(["/?app=inbox&ws=w1-api&pane=p1&view=chat"]);

    await act(async () => { mode.leave(); });
    expect(mode.on).toBe(false);
    expect(writes).toEqual(["pushState 1 ?ws=w1-api&pane=p1&view=chat"]);

    await back();
    expect(mode.on).toBe(true);
    expect(searches()).toEqual(["?app=inbox&ws=w1-api&pane=p1&view=chat", "?ws=w1-api&pane=p1&view=chat"]);
  });

  it("pushes nothing when asked for the mode it is already in", async () => {
    await mount(["/?app=inbox"]);
    await act(async () => { mode.enter(); });
    expect(writes).toEqual([]);
    await act(async () => { renderer?.unmount(); });

    await mount(["/?pane=p1"]);
    await act(async () => { mode.leave(); });
    expect(writes).toEqual([]);
  });

  it("says where the history is before React has drawn it", async () => {
    await mount(["/?pane=p1", "/?app=inbox"]);
    let seen: boolean[] = [];
    // registered before the hook's own listener would be: it reads the entry the pop landed on, not the drawn mode
    listeners.unshift(() => { seen = [mode.on, mode.at()]; });

    await back();

    expect(seen).toEqual([true, false]);
    expect(mode.on).toBe(false);
  });

  it("with the gate closed, ignores an address that says inbox and leaves it as it is", async () => {
    await mount(["/?app=inbox&pane=p1"], false);
    expect([mode.on, mode.at()]).toEqual([false, false]);

    await act(async () => { mode.enter(); });
    await act(async () => { mode.leave(); });

    expect(mode.on).toBe(false);
    expect(writes).toEqual([]);
    expect(searches()).toEqual(["?app=inbox&pane=p1"]);
    expect(listeners).toHaveLength(1);
  });

  it("writes the mode into the hosted shell's fragment", async () => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({ getAttribute: () => "relay" }) } });
    const scope = `/s/${"ab".repeat(16)}/`;
    await mount([`${scope}#pane=p1`]);
    expect(mode.on).toBe(false);

    await act(async () => { mode.enter(); });

    expect(writes).toEqual(["pushState 1 #pane=p1&app=inbox"]);
    expect([mode.on, mode.at()]).toEqual([true, true]);
  });
});
