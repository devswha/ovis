import { expect, it } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentInboxItem, AgentInboxState } from "../lib/agentInbox.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AgentInbox, AgentInboxButton, openAgentInboxItem } from "./AgentInbox.tsx";

function draw(node: ReactNode): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: node }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

it("shows a live Inbox count badge only when attention is waiting", () => {
  const counted = draw(<AgentInboxButton count={3} onOpen={() => {}} />);
  expect(counted).toContain("Inbox · 3 waiting for you");
  expect(counted).toContain('class="agent-inbox-count"');
  expect(counted).toContain(">3</span>");
  expect(draw(<AgentInboxButton count={0} onOpen={() => {}} />)).not.toContain('class="agent-inbox-count"');
});

it("shows the decision context and a direct route to the exact chat", () => {
  const item = {
    machine: { id: "mac", name: "Studio", snapshot: { tabs: [{ tab_id: "w1:t2", workspace_id: "w1", label: "Review", number: 2 }] } },
    entry: {
      pane: { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t2", label: "Approve release", agent: "codex", agent_status: "blocked", agent_kind: "permission", agent_message: "Run the deploy?" },
      workspace: { workspace_id: "w1", label: "ovis", tab_count: 2 },
      tab: { tab_id: "w1:t2", workspace_id: "w1", label: "Review", number: 2 },
      agent: null,
      canonicalAgent: "codex",
      agentLabel: "Codex",
    },
  } as AgentInboxItem;
  const markup = draw(<AgentInbox state={{ items: [item], loading: false, offline: 0 }} onOpen={() => {}} onClose={() => {}} />);
  for (const word of ["Review what each agent needs", "Approve release", "Studio", "ovis", "Review", "w1:p2", "Codex", "Needs permission", "Run the deploy?", "Open chat"]) expect(markup).toContain(word);
});

it("opens an Inbox item in Chat and closes the Inbox", () => {
  const calls: string[] = [];
  const item = { machine: { id: "mac" }, entry: { pane: { pane_id: "w1:p2" } } } as AgentInboxItem;
  openAgentInboxItem(item, (machineId, paneId, view) => calls.push(`${machineId}:${paneId}:${view}`), () => calls.push("close"));
  expect(calls).toEqual(["close", "mac:w1:p2:chat"]);
});

it("keeps useful loading, empty, and offline states in the open Inbox", () => {
  const state = (values: Partial<AgentInboxState>): AgentInboxState => ({ items: [], loading: false, offline: 0, ...values });
  const loading = draw(<AgentInbox state={state({ loading: true })} onOpen={() => {}} onClose={() => {}} />);
  expect(loading).toContain("Loading…");
  const empty = draw(<AgentInbox state={state({ offline: 1 })} onOpen={() => {}} onClose={() => {}} />);
  expect(empty).toContain("Nothing needs you right now.");
  expect(empty).toContain("Offline PCs are not included.");
});
