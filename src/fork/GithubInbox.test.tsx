import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { WorktreeListing } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ForkGithubRail, GithubInbox, setGithubSection } from "./GithubInbox.tsx";

let renderer: ReactTestRenderer | undefined;
const saved = new Map<string, PropertyDescriptor | undefined>();
const records = new Map<string, string>();
let calls = 0;
let payload: unknown;
let responseCode = 200;
beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT", "fetch"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  const events = new EventTarget(); records.clear(); calls = 0; responseCode = 200;
  payload = { account: "me", review: [{ repository: "owner/repo", number: 1, title: "Fix this", url: "https://github.com/owner/repo/pull/1", branch: "topic", checks: "failing", review: "review_required", workspace_id: "w1" }], yours: [] };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) } } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string) => { calls++; expect(url).toBe("/api/fork/github/pulls"); return Response.json(payload, { status: responseCode }); } });
  setGithubSection("inbox");
});
afterEach(async () => {
  await act(async () => renderer?.unmount()); renderer = undefined;
  for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});
const button = (name: string) => renderer!.root.findAllByType("button").find((node) => node.props["aria-label"] === name || node.findAll((child) => child.children.includes(name)).length > 0)!;
async function rail(enabled: boolean) {
  records.set("ovis:settings", JSON.stringify({ pullRequests: enabled }));
  await act(async () => { renderer = create(<SettingsProvider><ForkGithubRail><button aria-current="page">Inbox</button></ForkGithubRail></SettingsProvider>); });
}

const checkoutListing = (sourceId: string | null = "w1"): WorktreeListing => ({
  source: { repo_key: "repo", repo_name: "repo", repo_root: "/repo", source_checkout_path: sourceId ? "/repo" : "/linked", source_workspace_id: sourceId },
  worktrees: [{ path: "/pr", branch: "topic", label: "topic", is_linked_worktree: true, is_bare: false, is_detached: false, is_prunable: false, open_workspace_id: null }],
});
function checkoutApi(listings: WorktreeListing[], replies: Record<string, unknown> = {}) {
  const requests: { path: string; body?: unknown }[] = [];
  let reads = 0;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (path: string, init?: RequestInit) => {
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/api/fork/github/pulls") return Response.json(payload);
    if (path === "/api/worktree/list?workspace_id=w1") return Response.json(listings[Math.min(reads++, listings.length - 1)]);
    expect(Object.hasOwn(replies, path)).toBe(true);
    return Response.json(replies[path]);
  } });
  return requests;
}
async function openPull(onOpened = (_opened: unknown) => {}) {
  await act(async () => { renderer = create(<SettingsProvider><GithubInbox wide watching={false} onOpened={onOpened} /></SettingsProvider>); });
  await act(async () => button("Fix this").props.onClick());
}

test("opens an existing fork worktree without fetching or creating a branch", async () => {
  (payload as { review: { fork: boolean }[] }).review[0]!.fork = true;
  const opened = { workspace_id: "fork", pane_id: "p1", path: "/pr", branch: "topic", already_open: true };
  const requests = checkoutApi([checkoutListing()], { "/api/worktree/open": opened });
  let result: unknown;
  await openPull((next) => { result = next; });
  expect(button("Checkout")).toBeDefined();
  await act(async () => button("Checkout").props.onClick());
  expect(result).toEqual(opened);
  expect(requests.filter((request) => request.body)).toEqual([{ path: "/api/worktree/open", body: { workspace_id: "w1", path: "/pr" } }]);
});

test("does not offer a new fork checkout or a prunable fork worktree", async () => {
  (payload as { review: { fork: boolean }[] }).review[0]!.fork = true;
  for (const worktrees of [[], checkoutListing().worktrees.map((entry) => ({ ...entry, is_prunable: true }))]) {
    const requests = checkoutApi([{ ...checkoutListing(), worktrees }]);
    await openPull();
    expect(requests.some((request) => request.path.startsWith("/api/worktree/list"))).toBe(true);
    expect(button("Checkout")).toBeUndefined();
    expect(requests.filter((request) => request.body)).toHaveLength(0);
    await act(async () => renderer?.unmount());
  }
});

test("revalidates a fork worktree on checkout and never fetches when it has disappeared", async () => {
  (payload as { review: { fork: boolean }[] }).review[0]!.fork = true;
  const requests = checkoutApi([checkoutListing(), { ...checkoutListing(), worktrees: [] }]);
  await openPull();
  expect(button("Checkout")).toBeDefined();
  await act(async () => button("Checkout").props.onClick());
  expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();
  expect(requests.filter((request) => request.body)).toHaveLength(0);
});

test("creates from the main workspace when only a linked checkout is selected", async () => {
  for (const sourceId of [null, "main"]) {
    const listing = checkoutListing(sourceId);
    listing.source.source_checkout_path = "/linked"; listing.worktrees = [];
    const opened = { workspace_id: "new", pane_id: "p2", path: "/new", branch: "topic", already_open: false };
    const requests = checkoutApi([listing], {
      "/api/worktree/open": { workspace_id: "main", pane_id: "p0", path: "/repo", branch: "main", already_open: false },
      "/api/worktree/pull-request-fetch": { ref: "origin/topic" },
      "/api/worktree/create": opened,
    });
    let result: unknown;
    await openPull((next) => { result = next; });
    await act(async () => button("Checkout").props.onClick());
    expect(requests.filter((request) => request.body)).toEqual([
      ...(sourceId ? [] : [{ path: "/api/worktree/open", body: { workspace_id: "w1", path: "/repo" } }]),
      { path: "/api/worktree/pull-request-fetch", body: { workspace_id: "main", branch: "topic" } },
      { path: "/api/worktree/create", body: { workspace_id: "main", branch: "topic", base: "origin/topic" } },
    ]);
    expect(result).toEqual(opened);
    await act(async () => renderer?.unmount());
  }
});

test("rail is opt-in, switches current place, and Inbox switches back", async () => {
  await rail(false); expect(button("GitHub")).toBeUndefined();
  await act(async () => renderer?.unmount()); await rail(true);
  await act(async () => button("GitHub").props.onClick());
  expect(button("GitHub").props["aria-current"]).toBe("page");
  expect(button("Inbox").props["aria-current"]).toBeUndefined();
  await act(async () => button("Inbox").props.onClick());
  expect(button("Inbox").props["aria-current"]).toBe("page");
});

test("loads once, expands in place, filters, and refreshes without redirecting", async () => {
  await act(async () => { renderer = create(<SettingsProvider><GithubInbox wide={false} watching={false} onOpened={() => {}} /></SettingsProvider>); });
  expect(calls).toBe(1);
  expect(renderer!.root.findAllByType("a")).toHaveLength(0);
  await act(async () => button("Fix this").props.onClick());
  expect(renderer!.root.findByType("a").props.href).toBe("https://github.com/owner/repo/pull/1");
  expect(button("Checkout")).toBeDefined();
  await act(async () => button("owner/repo").props.onClick());
  expect(records.get("ovis:fork-github-repo")).toBe("owner/repo");
  await act(async () => button("Refresh").props.onClick()); expect(calls).toBe(2);
});

test("hides checkout for unknown repos and observers, and shows empty and CLI errors", async () => {
  for (const watching of [false, true]) {
    (payload as { review: { workspace_id?: string }[] }).review[0]!.workspace_id = watching ? "w1" : undefined;
    await act(async () => { renderer = create(<SettingsProvider><GithubInbox wide watching={watching} onOpened={() => {}} /></SettingsProvider>); });
    await act(async () => button("Fix this").props.onClick()); expect(button("Checkout")).toBeUndefined();
    await act(async () => renderer?.unmount());
  }
  payload = { account: "me", review: [], yours: [] };
  await act(async () => { renderer = create(<SettingsProvider><GithubInbox wide watching={false} onOpened={() => {}} /></SettingsProvider>); });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Nothing needs you");
  for (const code of ["gh_missing", "gh_signed_out", "rate_limited", "gh_failed"]) {
    responseCode = 409; payload = { error: { code, message: "Failure" } };
    await act(async () => button("Refresh").props.onClick());
    expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();
  }
});
