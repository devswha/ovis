import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { WorktreeListing } from "../../../shared/protocol.ts";
import { createGithubFilesReader } from "../../../server/fork/github.ts";
import { SettingsProvider } from "../../lib/settings.ts";
import { closeGithubPull, ForkGithubPane, ForkGithubRail, GithubInbox, refreshGithubListing } from "./GithubInbox.tsx";
import { setPlace } from "../inbox/place.ts";

let renderer: ReactTestRenderer | undefined;
const saved = new Map<string, PropertyDescriptor | undefined>();
const records = new Map<string, string>();
let calls = 0;
let payload: unknown;
let responseCode = 200;
beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT", "fetch", "cancelAnimationFrame"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  const events = new EventTarget(); records.clear(); calls = 0; responseCode = 200;
  payload = { accounts: ["me"], review: [{ repository: "owner/repo", number: 1, title: "Fix this", url: "https://github.com/owner/repo/pull/1", branch: "topic", checks: "failing", review: "review_required", workspace_id: "w1" }], yours: [] };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { history: { state: null, pushState() {} }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => records.set(key, value) } } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string) => {
    if (url.startsWith(DETAIL)) return detailUnread();
    calls++; expect(url).toBe("/api/fork/github/pulls"); return Response.json(payload, { status: responseCode });
  } });
  records.set("ovis:settings", JSON.stringify({ pullRequests: true }));
  refreshGithubListing();
  setPlace("inbox");
});
afterEach(async () => {
  await act(async () => renderer?.unmount()); renderer = undefined;
  closeGithubPull();
  for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});
// A pull request's page reads its detail; these tests are about the list and Checkout, so it stays unread.
const DETAIL = "/api/fork/github/pull?";
const detailUnread = () => Response.json({ error: { code: "gh_failed", message: "Unread" } }, { status: 409 });
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
    if (path.startsWith(DETAIL)) return detailUnread();
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/api/fork/github/pulls") return Response.json(payload);
    if (path === "/api/worktree/list?workspace_id=w1") return Response.json(listings[Math.min(reads++, listings.length - 1)]);
    expect(Object.hasOwn(replies, path)).toBe(true);
    return Response.json(replies[path]);
  } });
  return requests;
}
/** The wide layout: the list, and the page it opens beside it. */
async function wideGithub(watching = false, onOpened = (_opened: unknown) => {}) {
  setPlace("github");
  await act(async () => { renderer = create(<SettingsProvider><GithubInbox wide watching={watching} onOpened={onOpened} /><ForkGithubPane wide watching={watching} onOpened={onOpened} /></SettingsProvider>); });
}
async function openPull(onOpened = (_opened: unknown) => {}, watching = false) {
  await wideGithub(watching, onOpened);
  await act(async () => button("Fix this").props.onClick());
}
async function closeAll() { await act(async () => { renderer?.unmount(); closeGithubPull(); }); renderer = undefined; }

test("restores and records list scroll after returning from a phone PR", async () => {
  const hosts: (EventTarget & { scrollTop: number })[] = [];
  await act(async () => { renderer = create(<SettingsProvider><GithubInbox wide={false} watching={false} onOpened={() => {}} /></SettingsProvider>, {
    createNodeMock: (element) => {
      if (!element.props || typeof element.props !== "object" || !("className" in element.props) || !String(element.props.className).includes("inbox-scroll")) return null;
      const host = Object.assign(new EventTarget(), { scrollTop: 0 }); hosts.push(host); return host;
    },
  }); });
  hosts[0]!.scrollTop = 250; hosts[0]!.dispatchEvent(new Event("scroll"));
  await act(async () => button("Fix this").props.onClick());
  await act(async () => button("Back").props.onClick());
  expect(hosts[1]!.scrollTop).toBe(250);
  hosts[1]!.scrollTop = 320; hosts[1]!.dispatchEvent(new Event("scroll"));
  await act(async () => button("Fix this").props.onClick());
  await act(async () => button("Back").props.onClick());
  expect(hosts[2]!.scrollTop).toBe(320);
});

test("reloads open file patches when a cached PR receives a new head", async () => {
  (payload as { review: { url: string }[] }).review[0]!.url = "https://github.com/owner/repo/pull/9876";
  let detailReads = 0, patchReads = 0;
  let patch = "old head";
  const received: string[] = [];
  const readFiles = createGithubFilesReader(async (args) => {
    if (args[1] === "token") return { code: 0, stdout: "test-token", stderr: "" };
    patchReads++;
    return { code: 0, stdout: JSON.stringify([{ files: [{ filename: "a.txt", patch: `@@ -1 +1 @@\n-original\n+${patch}` }] }]), stderr: "" };
  }, () => 0);
  let resolveDetail: (response: Response) => void = () => {};
  const detail = { repository: "owner/repo", number: 1, url: "https://github.com/owner/repo/pull/9876", title: "Fix this", body: "", state: "open", draft: false, author: "me", created_at: "2026-01-01", updated_at: "2026-01-01", head: "topic", base: "main", fork: false, additions: 1, deletions: 0, changed_files: 1, commits: 1, checks: { passing: 0, failing: 0, pending: 0, skipped: 0 }, check_list: [], merge: "clean", review: "none", reviewers: [], labels: [], head_sha: "a".repeat(40), viewer: "me", can_write: false, merge_methods: [], conversation: [], files: [{ path: "a.txt", additions: 1, deletions: 0, change: "modified" }] };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string) => {
    if (url.startsWith("/api/fork/github/pull/files?")) {
      const params = new URL(url, "http://localhost").searchParams;
      const files = await readFiles("owner/repo", 1, "me", params.get("head") ?? "", params.get("base") ?? "");
      received.push(files[0]?.patch ?? "");
      // Rendering the diff needs browser workers; the assertion above captures the real server patch.
      return Response.json({ files: files.map((file) => ({ ...file, patch: null })) });
    }
    if (url.startsWith(DETAIL)) { detailReads++; return detailReads === 1 ? Response.json(detail) : new Promise<Response>((resolve) => { resolveDetail = resolve; }); }
    return Response.json(payload);
  } });
  await openPull();
  await act(async () => button("Files 1").props.onClick());
  await act(async () => button("Expand all").props.onClick());
  expect(patchReads).toBe(1);
  await act(async () => { renderer?.unmount(); closeGithubPull(); });
  await openPull();
  expect(button("Collapse all")).toBeDefined();
  patch = "new head";
  await act(async () => { resolveDetail(Response.json({ ...detail, head_sha: "b".repeat(40) })); });
  expect(received[1]).toContain("new head");
  expect(patchReads).toBe(2);
  expect(button("Collapse all")).toBeDefined();
});

test("opens an existing same-repository worktree without fetching or creating a branch", async () => {
  const opened = { workspace_id: "fork", pane_id: "p1", path: "/pr", branch: "topic", already_open: true };
  const requests = checkoutApi([checkoutListing()], { "/api/worktree/open": opened });
  let result: unknown;
  await openPull((next) => { result = next; });
  expect(button("Checkout")).toBeDefined();
  await act(async () => button("Checkout").props.onClick());
  expect(result).toEqual(opened);
  expect(requests.filter((request) => request.body)).toEqual([{ path: "/api/worktree/open", body: { workspace_id: "w1", path: "/pr" } }]);
});

test("fork PRs offer only GitHub, even when an unrelated local branch has the same name", async () => {
  (payload as { review: { fork: boolean }[] }).review[0]!.fork = true;
  for (const worktrees of [checkoutListing().worktrees, []]) {
    const requests = checkoutApi([{ ...checkoutListing(), worktrees }]);
    await openPull();
    expect(button("Checkout")).toBeUndefined();
    expect(renderer!.root.findByType("a").props.href).toBe("https://github.com/owner/repo/pull/1");
    expect(requests).toEqual([{ path: "/api/fork/github/pulls", body: undefined }]);
    await closeAll(); refreshGithubListing();
  }
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
    await closeAll(); refreshGithubListing();
  }
});

test("rail is opt-in, switches current place, and Inbox switches back", async () => {
  await rail(false); expect(button("Pull requests")).toBeUndefined();
  await act(async () => renderer?.unmount()); await rail(true);
  await act(async () => button("Pull requests").props.onClick());
  expect(button("Pull requests").props["aria-current"]).toBe("page");
  expect(button("Inbox").props["aria-current"]).toBeUndefined();
  await act(async () => button("Inbox").props.onClick());
  expect(button("Inbox").props["aria-current"]).toBe("page");
});

test("loads once, opens the page beside the list, and refreshes without redirecting", async () => {
  await wideGithub();
  expect(calls).toBe(1);
  expect(renderer!.root.findAllByType("a")).toHaveLength(0);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Choose a pull request to open it here.");
  await act(async () => button("Fix this").props.onClick());
  expect(renderer!.root.findByType("a").props.href).toBe("https://github.com/owner/repo/pull/1");
  expect(button("Checkout")).toBeDefined();
  // one repository: no filter to offer (githubGroups' own tests cover choosing one)
  expect(button("Repositories")).toBeUndefined();
  await act(async () => button("Refresh").props.onClick()); expect(calls).toBe(2);
});

test("offers a clone for unknown repos, nothing to observers, and shows empty and CLI errors", async () => {
  for (const watching of [false, true]) {
    (payload as { review: { workspace_id?: string }[] }).review[0]!.workspace_id = watching ? "w1" : undefined;
    await openPull(() => {}, watching);
    expect(button("Checkout")).toBeUndefined();
    expect(button("Clone and checkout") !== undefined).toBe(!watching);
    await closeAll(); refreshGithubListing();
  }
  setPlace("inbox");
  payload = { accounts: ["me"], review: [], yours: [] };
  await act(async () => { renderer = create(<SettingsProvider><GithubInbox wide watching={false} onOpened={() => {}} /></SettingsProvider>); });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Nothing needs you");
  for (const code of ["gh_missing", "gh_signed_out", "rate_limited", "gh_failed"]) {
    responseCode = 409; payload = { error: { code, message: "Failure" } };
    await act(async () => button("Refresh").props.onClick());
    expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();
  }
});
