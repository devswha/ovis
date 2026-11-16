import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../../shared/machines.ts";
import { SettingsProvider } from "../../lib/settings.ts";
import { showPaneEndedNotification, showPaneStatusNotification } from "../../lib/notifications.ts";
import { AgentAvatar, friendMood } from "./AgentAvatar.tsx";
import { useAgentFriends } from "./friends.ts";
import { ForkInboxAvatar } from "../inbox/InboxAvatar.tsx";
import { useForkNotificationState } from "./notifications.ts";

const machine = { id: "m1", state: "connected", snapshot: { panes: [{ pane_id: "p1", agent: "claude" }, { pane_id: "p2", agent: "codex" }] } } as unknown as Machine;

/** the stored settings this device has, and the friends /api/friends answers */
const asks = { started: 0, answered: 0 };
function device(agentFriends: boolean, friends: Record<string, string>) {
  asks.started = 0;
  asks.answered = 0;
  const win = globalThis.window as unknown as { localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> };
  win.localStorage = { getItem: (key) => key === "ovis:settings" ? JSON.stringify({ agentFriends }) : null, setItem() {}, removeItem() {} };
  globalThis.fetch = (async () => {
    asks.started += 1;
    const answer = new Response(JSON.stringify({ friends }), { headers: { "content-type": "application/json" } });
    asks.answered += 1;
    return answer;
  }) as unknown as typeof fetch;
}

function Asking({ children }: { children: React.ReactNode }) {
  useAgentFriends([machine]);
  useForkNotificationState("unsupported", () => {}, [machine]);
  return <>{children}</>;
}

describe("AgentAvatar", () => {
  const realFetch = globalThis.fetch;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    const media = { matches: true, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      matchMedia: () => media, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      requestAnimationFrame: () => 1, cancelAnimationFrame() {}, location: { href: "http://localhost/" },
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      body: { nodeType: 1, children: [] }, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    globalThis.fetch = realFetch;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const draw = async (avatar: React.ReactNode): Promise<string> => {
    await act(async () => { renderer = create(<SettingsProvider><Asking>{avatar}</Asking></SettingsProvider>); });
    // the answer to /api/friends lands after the first paint: wait for it, bounded
    const deadline = Date.now() + 2_000;
    while (asks.answered < asks.started) {
      if (Date.now() > deadline) throw new Error("/api/friends was not answered");
      await Bun.sleep(5);
    }
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    return JSON.stringify(renderer!.toJSON());
  };

  it("draws the friend alone, with no harness logo, when Agent friends is on and the pane has one", async () => {
    device(true, { "m1:p1": "neko" });
    const out = await draw(<AgentAvatar agent="claude" size={18} machineId="m1" paneId="p1" status="working" />);
    expect(out).toContain("agent-friend is-working");
    expect(out).toContain('"width":22');
    expect(out).not.toContain("agent-mark");
  });

  it("draws the agent's mark when friends are off, the pane has none, or no pane is named", async () => {
    device(false, { "m1:p1": "neko" });
    expect(await draw(<AgentAvatar agent="claude" size={18} machineId="m1" paneId="p1" />)).toContain("agent-mark");
    await act(async () => renderer?.unmount());
    device(true, { "m1:p1": "neko" });
    const none = await draw(<><AgentAvatar agent="codex" machineId="m1" paneId="p2" /><AgentAvatar agent="claude" machineId="m1" /></>);
    expect(none).not.toContain("agent-friend");
    expect(none.match(/agent-mark/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("looks up an alert's friend by PC and pane, and obeys Agent friends", async () => {
    const notification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
    const pane = machine.snapshot!.panes[0]!;
    const agent = pane.agent;
    try {
      device(true, { "m1:p1": "neko" });
      await draw(<AgentAvatar agent="claude" machineId="m1" paneId="p1" />);
      const shown: NotificationOptions[] = [];
      Object.defineProperty(globalThis, "Notification", { configurable: true, value: { permission: "granted" } });
      Object.assign(document, { hidden: true });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { getRegistration: async () => ({ active: {}, showNotification: async (_title: string, options: NotificationOptions) => { shown.push(options); } }) } } });
      await showPaneStatusNotification("p1", "Pi", "done", undefined, "m1");
      await showPaneEndedNotification("p1", "Pi", undefined, "another-pc");
      pane.agent = null;
      await act(async () => { renderer!.update(<SettingsProvider><Asking><span /></Asking></SettingsProvider>); });
      await showPaneEndedNotification("p1", "Terminal", undefined, "m1");
      device(false, {});
      await showPaneStatusNotification("p1", "Pi", "done", undefined, "m1");
      expect(shown.map((entry) => entry.icon)).toEqual(["/friends/neko.png", "/icons/icon-192.png?v=sheep1", "/icons/icon-192.png?v=sheep1", "/icons/icon-192.png?v=sheep1"]);
    } finally {
      pane.agent = agent;
      if (notification) Object.defineProperty(globalThis, "Notification", notification);
      else Reflect.deleteProperty(globalThis, "Notification");
    }
  });

  it("keeps the inbox's original face without a friend and uses the same friend in threads", async () => {
    const row = { machine, pane: machine.snapshot!.panes[0]!, mark: "claude" };
    device(false, {});
    const original = await draw(<ForkInboxAvatar row={row} />);
    expect(original).toContain("inbox-avatar-face");
    expect(original).not.toContain("agent-friend");
    await act(async () => renderer?.unmount());
    device(true, { "m1:p1": "neko" });
    const friend = await draw(<ForkInboxAvatar row={row} />);
    expect(friend).toContain("agent-friend");
    expect(friend).not.toContain("agent-mark");
  });

  it("refreshes project friends after a move or parent change with the same pane IDs", async () => {
    device(true, {});
    const requests: unknown[] = [];
    const picks = ["neko", "kuma", "hoshi", "mikan"];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ friends: { "moving:p1": picks[requests.length - 1] } }));
    }) as typeof fetch;
    const roster = (workspace: string, parent?: string, parentWorkspace = "conductor-project"): Machine[] => [{ ...machine, id: "moving", snapshot: { ...machine.snapshot!,
      panes: machine.snapshot!.panes.map((pane, index) => ({ ...pane,
        agent: index === 0 ? pane.agent : null, workspace_id: index === 0 ? workspace : parentWorkspace,
        parent_pane_id: index === 0 ? parent : undefined,
      })),
    } }];
    function Reading({ machines }: { machines: Machine[] }) {
      const friends = useAgentFriends(machines);
      return <output>{friends["moving:p1"] ?? ""}</output>;
    }
    const view = (machines: Machine[]) => <SettingsProvider><Reading machines={machines} /></SettingsProvider>;
    const update = async (machines: Machine[], pick: string, count: number) => {
      await act(async () => { renderer!.update(view(machines)); });
      expect(requests).toHaveLength(count);
      expect(renderer!.root.findByType("output").children).toEqual([pick]);
    };
    await act(async () => { renderer = create(view(roster("project-a"))); });
    expect(renderer!.root.findByType("output").children).toEqual(["neko"]);
    await update(roster("project-b"), "kuma", 2);
    await update(roster("project-b", "p2"), "hoshi", 3);
    await update(roster("project-b", "p2", "parent-moved"), "mikan", 4);
    // Snapshot churn that leaves project identities alone must not add requests.
    await update(roster("project-b", "p2", "parent-moved"), "mikan", 4);
    expect(requests).toEqual(Array.from({ length: 4 }, () => ({ live: ["moving:p1"], machines: ["moving"] })));
  });

  it.each(["response", "body"])("ignores an old project's late %s after a newer move finishes", async (delay) => {
    device(true, {});
    const id = `race-${delay}`;
    const oldFetch = Promise.withResolvers<Response>();
    const oldBody = Promise.withResolvers<string>();
    const oldResponse = new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(await oldBody.promise));
        controller.close();
      },
    }));
    let requests = 0;
    globalThis.fetch = Object.assign(async () => {
      requests += 1;
      if (requests === 1) return delay === "body" ? oldResponse : oldFetch.promise;
      return new Response(JSON.stringify({ friends: { [`${id}:p1`]: "kuma" } }));
    }, { preconnect() {} });
    function Reading({ workspace }: { workspace: string }) {
      const friends = useAgentFriends([{ ...machine, id, snapshot: { ...machine.snapshot!,
        panes: machine.snapshot!.panes.map((pane) => ({ ...pane, workspace_id: workspace })),
      } }]);
      return <output>{friends[`${id}:p1`] ?? ""}</output>;
    }
    const view = (workspace: string) => <SettingsProvider><Reading workspace={workspace} /></SettingsProvider>;
    await act(async () => { renderer = create(view("project-a")); });
    expect(requests).toBe(1);
    await act(async () => { renderer!.update(view("project-b")); });
    expect(requests).toBe(2);
    expect(renderer!.root.findByType("output").children).toEqual(["kuma"]);
    await act(async () => {
      oldBody.resolve(JSON.stringify({ friends: { [`${id}:p1`]: "neko" } }));
      oldFetch.resolve(oldResponse);
    });
    expect(renderer!.root.findByType("output").children).toEqual(["kuma"]);
    expect(requests).toBe(2);
  });

  it("maps a pane's status to its friend's mood", () => {
    expect([friendMood("waiting"), friendMood("unknown"), friendMood("done"), friendMood(undefined)]).toEqual(["working", undefined, "done", undefined]);
  });
});
