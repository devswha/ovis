import { afterEach, expect, it, jest, mock } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { RelayPairingRequest } from "../../shared/machines.ts";
import type { PromptPairing } from "../components/RelayPairingPrompt.tsx";

const JOINS = [{ id: "join-1", label: "Phone", digits: "123456", left_ms: 60_000 }, { id: "join-2", label: "Galaxy", left_ms: 60_000 }];
const TAILNET = { pending: { id: "nPhone1CNTRL", hostname: "pixel", login: "owner@example.com", asked_at: "2026-11-21T00:00:00.000Z" }, nodes: [] };
const asked: boolean[] = [];
await mock.module("../components/OwnJoins.tsx", () => ({ useOwnJoins: (enabled: boolean) => { asked.push(enabled); return enabled ? JOINS : []; } }));
await mock.module("./useTailnetNodes.ts", () => ({ useTailnetNodes: (enabled: boolean) => enabled ? TAILNET : null }));
const { useOwnWindowPrompts } = await import("./useOwnWindowPrompts.ts");

let renderer: ReactTestRenderer | undefined;
let prompts: readonly PromptPairing[] = [];
let joins: readonly { id: string }[] = [];
function Probe({ pairings, ownWindow = true, unlocked = true }: { pairings: readonly RelayPairingRequest[]; ownWindow?: boolean; unlocked?: boolean }) {
  ({ prompts, joins } = useOwnWindowPrompts(pairings, [], ownWindow, unlocked));
  return null;
}

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  jest.useRealTimers();
});

it("keeps a first join's deadline when an unrelated update rebuilds the prompts", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-21T00:00:00Z"));
  await act(async () => { renderer = create(createElement(Probe, { pairings: [] })); });
  const first = prompts.find((prompt) => prompt.id === "join-1")?.expires_at;
  expect(first).toBe("2026-11-21T00:01:00.000Z");
  jest.setSystemTime(new Date("2026-11-21T00:00:02Z"));
  await act(async () => { renderer!.update(createElement(Probe, { pairings: [] })); });
  expect(prompts.find((prompt) => prompt.id === "join-1")?.expires_at).toBe(first);
});

it("puts a removed Tailscale device on this PC's own window alone, with its node id and login", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  await act(async () => { renderer = create(createElement(Probe, { pairings: [] })); });
  expect(prompts.find((prompt) => prompt.own_window === "tailnet")).toMatchObject({ id: "nPhone1CNTRL", label: "pixel", digits: "nPhone1CNTRL", login: "owner@example.com" });
  await act(async () => { renderer!.update(createElement(Probe, { pairings: [], ownWindow: false })); });
  expect(prompts.filter((prompt) => prompt.own_window === "tailnet")).toEqual([]);
});

it("#16: a members join (no digits) goes to the own window's card, not the tap prompts; a locked PC is not asked", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  asked.length = 0;
  await act(async () => { renderer = create(createElement(Probe, { pairings: [] })); });
  expect(prompts.filter((prompt) => prompt.own_window !== "tailnet").map((prompt) => prompt.id)).toEqual(["join-1"]);
  expect(joins.map((join) => join.id)).toEqual(["join-1", "join-2"]);
  await act(async () => { renderer!.update(createElement(Probe, { pairings: [], unlocked: false })); });
  expect(asked.at(-1)).toBe(false);
  expect(joins).toEqual([]);
});
