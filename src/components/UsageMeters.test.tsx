import { afterEach, beforeEach, describe, expect, it, spyOn, mock } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import { UsageMeters } from "./UsageMeters.tsx";
import * as api from "../lib/api.ts";
import * as settingsLib from "../lib/settings.ts";
import type { Machine } from "../../shared/machines.ts";

const node = (): HTMLElement => ({
  isConnected: true, offsetWidth: 200, offsetHeight: 100, dataset: {}, style: {}, clientWidth: 400,
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  querySelector: () => null, querySelectorAll: () => [], contains: () => false, closest: () => null,
  focus() {}, addEventListener() {}, removeEventListener() {},
}) as unknown as HTMLElement;

let renderer: ReactTestRenderer | undefined;
const saved = new Map<string, PropertyDescriptor | undefined>();

const connected = (...agents: string[]): Machine => ({
  id: "local", kind: "local", name: "Laptop", state: "connected", error: null, action_required: null, remote_ovis: null,
  snapshot: {
    protocol: 22, version: "test", agents: [], tabs: [], layouts: [],
    workspaces: [{ workspace_id: "w1", active_tab_id: "w1:t1", label: "Work", number: 1, tab_count: 1, pane_count: agents.length, focused: false, agent_status: "idle" }],
    panes: agents.map((agent, index) => ({ agent, pane_id: `p${index}`, terminal_id: `t${index}`, workspace_id: "w1", tab_id: "w1:t1", revision: 1, focused: false, agent_status: "idle" })),
  }
} as any);

describe("UsageMeters", () => {
  const keys = ["window", "document", "HTMLElement", "navigator", "IS_REACT_ACT_ENVIRONMENT"];
  beforeEach(() => {
    for (const key of keys) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));

    spyOn(settingsLib, "useSettings").mockReturnValue({ settings: { showUsage: true, usageHidden: [], usageOrder: [], usageGlance: "windows", usageCount: "left" } as any, resolvedLanguage: "en" as any, update: () => {}, watch: () => () => {}, own: () => ({} as any), resolvedTheme: "dark", resolvedEntry: {} as any });

    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, writable: true, value: class {} });
    Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { addEventListener: () => {}, removeEventListener: () => {}, setTimeout: (cb: any) => { cb(); return 1; }, clearTimeout: () => {} } });

    const root = new (class { style = {}; dataset = {}; classList = { add() {}, remove() {} } })();
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: {
      addEventListener: () => {}, removeEventListener: () => {}, setTimeout: (cb: any) => { cb(); return 1; }, clearTimeout: () => {}, body: { nodeType: 1, children: [], appendChild: () => {}, removeChild: () => {}, createNodeMock: node },
      activeElement: null,
      querySelector: () => null, querySelectorAll: () => [],
      documentElement: root
    } });
  });

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = undefined;
    mock.restore();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it("keeps the dialog open even when the strip is hidden", async () => {
    let resolveUsage: (val: any) => void;
    const usagePromise = new Promise(resolve => resolveUsage = resolve);
    spyOn(api, "fetchUsage").mockReturnValue(usagePromise as any);
    spyOn(api, "fetchUsageLoginAccounts").mockResolvedValue({ accounts: [] });
    spyOn(api, "followUsageLogin").mockResolvedValue({ login_id: "login-1", device_auth: false });

    await act(async () => {
      renderer = create(
        createElement(UsageMeters, { machines: [connected("claude")], onLocalLogin: () => {} }),
        { createNodeMock: node }
      );
    });

    await act(async () => {
      resolveUsage({
        providers: [
          {
            id: "claude",
            key: "claude-1",
            plan: "Pro",
            account: "test@example.com",
            windows: [],
            problem: "expired",
          }
        ]
      });
    });

    const root = renderer!.root;

    const strip = root.findAll(node => node.type === "button" && node.props.className === "usage-strip")[0]!;
    await act(async () => { strip.props.onClick(); });

    const signInAgainContainer = root.findAll(node => node.type === "span" && String(node.props.className).includes("usage-sign-in-again"))[0]!;
    const signInAgain = signInAgainContainer.findAll(node => node.type === "button")[0]!;
    await act(async () => { signInAgain.props.onClick(); });

    let dialogs = root.findAll(node => node.type === "div" && String(node.props.className).includes("usage-sign-in-dialog"));
    expect(dialogs.length).toBe(1);

    // Check that strip exists before we make it disappear
    expect(root.findAll(node => node.type === "button" && node.props.className === "usage-strip").length).toBe(1);

    // Now hide strip by providing empty panes in machine
    await act(async () => {
      renderer?.update(
        createElement(UsageMeters, { machines: [connected()], onLocalLogin: () => {} })
      );
    });

    expect(root.findAll(node => node.type === "button" && node.props.className === "usage-strip").length).toBe(0);
    dialogs = root.findAll(node => node.type === "div" && String(node.props.className).includes("usage-sign-in-dialog"));
    expect(dialogs.length).toBe(1);
  });
});
