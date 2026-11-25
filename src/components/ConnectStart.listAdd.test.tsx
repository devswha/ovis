import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { AccountList } from "../lib/account/accountList.ts";
import type { MyPc } from "../lib/account/myPcs.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { MyPcs } from "./ConnectStart.tsx";

const ACCOUNT = "acct_owner";
const ids = { mini: "c".repeat(32), home: "d".repeat(32) };
const pc = (server_id: string, name: string): MyPc => ({ server_id, name, state: "needs-approval", last_seen_at: null, added_at: new Date().toISOString(), listed: true, paired: false, linked: false, join: { server_public_key: "k", relay: "wss://relay.ovis.sh" } });
const phone = { pcs: [], recent: [], current: null, sshPort: null, read: true, reread: () => {} } as never;
/** this phone's list, as far as My PCs asks it: a stand-in that the number dialog asks in vain */
const list = { writer: () => null, view: () => ({ account: ACCOUNT, status: { at: "off" }, reached: false, devices: [], pcs: [] }), subscribe: () => () => {} } as unknown as AccountList;
const postOf = (server_id: string) => ({ list: "f".repeat(64), endpoint: "e".repeat(64), server_id, key: "member-key", enc: "enc-key", card: "card", for: { kind: "add" as const } });

const globals = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
/** each PC's row (its name, way and word) as it opens: the PC's own page by its link, or a press here */
const opens = (): [string, string][] => renderer!.root.findAll((node) => node.props.className === "relay-add-saved-pc")
  .map((node) => [textOf(node).replace(/\s+/g, " ").trim(), node.type === "a" ? `link ${String(node.props.href)}` : "press"]);

beforeEach(() => {
  const events = new EventTarget();
  for (const [name, value] of Object.entries({
    window: Object.assign(events, { location: new URL("https://app.ovis.sh/"), matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), history: { state: null, pushState() {}, replaceState() {}, back() {} } }),
    IS_REACT_ACT_ENVIRONMENT: true,
    document: Object.assign(new EventTarget(), { visibilityState: "visible", hidden: false, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    navigator: { languages: ["en"], onLine: true, userAgent: "Mozilla/5.0", maxTouchPoints: 0 },
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  setPageAccountList(list);
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  setPageAccountList(null);
  for (const [name, descriptor] of globals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  globals.clear();
});

describe("My PCs on an account that keeps a signed list", () => {
  it("opens the number card for a PC that posted its keys for the list, never its own page's join; one that posted nothing opens as today", async () => {
    const asked: string[] = [];
    const listOf = async (account: string) => { asked.push(account); return { account, list, posts: [postOf(ids.mini)] }; };
    await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(MyPcs, { devices: [], accountPcs: [pc(ids.mini, "Mac mini"), pc(ids.home, "Home server")], phone, listOf }) })); });
    await settle();
    expect(asked).toEqual([ACCOUNT]);
    expect(opens()).toEqual([["Mac miniRelayOn", "press"], ["Home serverRelayOn", `link /s/${ids.home}/`]]);
    const row = renderer!.root.find((node) => node.props.className === "relay-add-saved-pc" && node.type !== "a");
    await act(async () => { row.props.onClick(); });
    await settle();
    expect(renderer!.root.findAll((node) => node.props["data-testid"] === "add-pc-number").map((node) => node.props["data-pc-id"])).toEqual([ids.mini]);
  });

  it("keeps every row as it is on an account with no list", async () => {
    const listOf = async () => null;
    await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(MyPcs, { devices: [], accountPcs: [pc(ids.mini, "Mac mini")], phone, listOf }) })); });
    await settle();
    expect(opens()).toEqual([["Mac miniRelayOn", `link /s/${ids.mini}/`]]);
  });
});
