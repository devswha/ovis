import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { listView } from "../../shared/account-list.ts";
import { JOIN_LINE_PREFIX, readJoinLine } from "../../shared/account-list-join.ts";
import { listWorld, type WorldDevice } from "../lib/account/accountList.test-helpers.ts";
import { INVITE_S } from "../lib/account/listInvite.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import { AccountRelayPanel } from "./ConnectStart.tsx";
import { agentCommand, InvitePc } from "./InvitePc.tsx";

type World = ReturnType<typeof listWorld>;

const globals = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let copied: string[] = [];

const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const buttons = (): string[] => renderer!.root.findAll((node) => node.type === "button").map((node) => textOf(node).trim());
const press = async (find: (node: ReactTestInstance) => boolean): Promise<void> => {
  const found = renderer!.root.findAll((node) => node.type === "button" && find(node));
  if (found.length !== 1) throw new Error(`${found.length} buttons match`);
  await act(async () => { await found[0]!.props.onClick(); });
  await settle();
};
const action = (name: string) => (node: ReactTestInstance): boolean => node.props["data-action"] === name;
const text = (): string => renderer!.root.findAll((node) => node.props["data-testid"] === "invite-pc").map(textOf).join(" ");
const rows = (): string[] => renderer!.root.findAll((node) => node.type === "li").map((node) => `${node.props["data-invite-state"]}: ${textOf(node)}`);
const shown = (mark: string): string | undefined => renderer!.root.findAll((node) => node.props[mark] === "").map(textOf)[0];

beforeEach(() => {
  copied = [];
  for (const [name, value] of Object.entries({
    window: Object.assign(new EventTarget(), { location: new URL("https://app.ovis.sh/"), matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }),
    IS_REACT_ACT_ENVIRONMENT: true,
    document: Object.assign(new EventTarget(), { visibilityState: "visible", querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    navigator: { languages: ["en"], clipboard: { writeText: async (value: string) => { copied.push(value); } } },
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
});

async function mounted(): Promise<{ w: World; first: WorldDevice }> {
  const w = listWorld();
  const first = await w.device({ label: "Dana's phone" });
  await first.list.sync();
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(InvitePc, { list: first.list, now: () => w.clock.now }) })); });
  await settle();
  return { w, first };
}

describe("invites for a PC, on a device that may write its account's list", () => {
  it("makes an invite a PC joins with by itself, shows its line and the one line for an agent with the account's id, and copies each", async () => {
    const { w } = await mounted();
    expect(buttons()).toEqual(["Make an invite"]);
    expect(text()).toContain("It works once.");
    await press(action("make-invite"));
    const line = shown("data-invite-line")!;
    expect(line.startsWith(JOIN_LINE_PREFIX)).toBe(true);
    const read = await readJoinLine(line, { service: w.origin, followsLists: true });
    expect(listView(w.held().state).invites.map((row) => [row.key, row.uses, row.auto])).toEqual([[read.key, 1, true]]);
    // the one line an agent runs names the whole account id and never holds the invite
    expect(shown("data-invite-command")).toBe(agentCommand(w.account));
    expect(agentCommand(w.account)).toBe(`curl -fsSL https://ovis.sh/install.sh | sh -s -- --join-file ~/ovis-invite.txt --account ${w.account}`);
    expect(text()).toContain("For an agent");
    expect(text()).toContain("Anyone who has this invite can add a PC to your account.");
    expect(rows()).toEqual([`open: Invite · Expires in ${INVITE_S / 60} minRevoke`]);
    const copies = renderer!.root.findAll((node) => node.type === "button" && textOf(node) === "Copy");
    expect(copies).toHaveLength(2);
    await act(async () => { copies[0]!.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findAll((node) => node.type === "button" && textOf(node) === "Copy")[0]!.props.onClick(); });
    await settle();
    expect(copied).toEqual([line, agentCommand(w.account)]);
  });

  it("counts the minutes down, and once the time is over shows the invite as expired with no line and nothing to revoke", async () => {
    const { w } = await mounted();
    await press(action("make-invite"));
    w.clock.now += 9 * 60_000 + 30_000;
    await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(InvitePc, { list: (renderer!.root.findByType(InvitePc).props as { list: WorldDevice["list"] }).list, now: () => w.clock.now }) })); });
    expect(rows()).toEqual(["open: Invite · Expires in 5 minRevoke"]);
    w.clock.now += 5 * 60_000;
    await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(InvitePc, { list: (renderer!.root.findByType(InvitePc).props as { list: WorldDevice["list"] }).list, now: () => w.clock.now }) })); });
    expect(rows()).toEqual(["expired: Invite · Expired"]);
    expect(shown("data-invite-line")).toBeUndefined();
    expect(shown("data-invite-command")).toBeUndefined();
    // and an hour on it is listed no more
    w.clock.now += 61 * 60_000;
    await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(InvitePc, { list: (renderer!.root.findByType(InvitePc).props as { list: WorldDevice["list"] }).list, now: () => w.clock.now }) })); });
    expect(rows()).toEqual([]);
  });

  it("revokes an open invite: its line goes, and the row says so", async () => {
    const { w } = await mounted();
    await press(action("make-invite"));
    const key = listView(w.held().state).invites[0]!.key;
    await press(action("revoke-invite"));
    expect(listView(w.held().state).invites.map((row) => [row.key, row.refusal])).toEqual([[key, "invite_revoked"]]);
    expect(rows()).toEqual(["revoked: Invite · Revoked"]);
    expect(shown("data-invite-line")).toBeUndefined();
  });

  it("says why no invite was made, and shows no line", async () => {
    const { first } = await mounted();
    first.wire.answer = (request) => new URL(request.url).pathname === "/v1/pc-invites" ? Response.json({ error: { code: "invites_full", message: "Revoke an open invite first" } }, { status: 409 }) : null;
    await press(action("make-invite"));
    expect(text()).toContain("Your account has as many open invites as it can. Revoke one first.");
    expect(shown("data-invite-line")).toBeUndefined();
    expect(rows()).toEqual([]);
  });

  it("draws nothing on a device that may not write the list", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const second = await w.device({ label: "Dana's tablet" });
    await second.list.sync();
    await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(InvitePc, { list: second.list }) })); });
    expect(renderer!.root.findAll((node) => node.props["data-testid"] === "invite-pc")).toEqual([]);
  });
});

describe("the signed-in relay tab of Add PC", () => {
  const code = { start() {}, submit() {}, cancel() {}, state: { active: false, looking: false, failure: null } };
  const drawn = async (userAgent: string, list: WorldDevice["list"] | null): Promise<number> => {
    Object.defineProperty(globalThis, "navigator", { value: { languages: ["en"], userAgent }, configurable: true });
    setPageAccountList(list);
    try {
      await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(AccountRelayPanel, { code }) })); });
      const found = renderer!.root.findAll((node) => node.props["data-testid"] === "invite-pc").length;
      await act(async () => { renderer!.unmount(); });
      renderer = undefined;
      return found;
    } finally { setPageAccountList(null); }
  };

  it("offers invites in the Mac app on a device that may write the list, and nowhere else", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's Mac" });
    await first.list.sync();
    const second = await w.device({ label: "Dana's tablet" });
    await second.list.sync();
    const mac = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 OvisMac/1.0";
    expect(await drawn(mac, first.list)).toBe(1);
    // a device that waits to be let in, a page with no list, and a browser or a phone
    expect(await drawn(mac, second.list)).toBe(0);
    expect(await drawn(mac, null)).toBe(0);
    expect(await drawn("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15", first.list)).toBe(0);
  });
});
