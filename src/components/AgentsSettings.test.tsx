import { expect, spyOn, test } from "bun:test";

import { AGENT_CATALOG, catalogRow } from "../../shared/agent-catalog.ts";
import { openPage } from "../lib/page.fixture.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AgentsSettings } from "./AgentsSettings.tsx";

test.each([
  { label: "known missing", installed: false, pathProblem: undefined, showsNote: true },
  { label: "unknown", installed: null, pathProblem: undefined, showsNote: false },
  { label: "PATH unreadable", installed: false, pathProblem: "Could not read PATH", showsNote: false },
  { label: "installed", installed: true, pathProblem: undefined, showsNote: false },
] as const)("shows Codex's install status without removing its launch settings ($label)", async ({ installed, pathProblem, showsNote }) => {
  const page = openPage();
  const agents = AGENT_CATALOG.filter(({ id }) => id === "claude" || id === "codex").map((entry) => {
    const present = entry.id === "claude" ? true : installed;
    return catalogRow(entry, "linux", {
      installed: present, binary: present ? entry.detect.binaries[0] ?? null : null, on_path: present,
      version: null, version_error: null, meets_min_version: null,
    });
  });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
    switch (String(input)) {
      case "/api/agent-catalog": return Response.json({ platform: "linux", agents, path_problem: pathProblem });
      case "/api/integrations": return Response.json({ integrations: [] });
      case "/api/cliproxy": return Response.json({ configured: false });
      default: throw new Error(`Unexpected request: ${String(input)}`);
    }
  }, { preconnect: globalThis.fetch.preconnect }));
  const resizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: page.window.ResizeObserver });
  try {
    const noop = () => {};
    await page.render(<SettingsProvider>
      <AgentsSettings watching={false} onLocalLogin={noop} onOpenPane={noop} onOpenGuide={noop} />
    </SettingsProvider>);
    const installedList = page.one('[data-section="agents-installed"]');
    expect(installedList.querySelector('[data-agent="claude"]')).not.toBeNull();
    expect(installedList.querySelector('[data-agent="codex"]') !== null).toBe(installed === true);
    const group = page.container.querySelector('[data-section="agent-codex"]');
    if (installed === true) {
      expect(group).toBeNull();
    } else {
      expect(group?.querySelector("#settings-codex-launch-model")).toBeInstanceOf(page.window.HTMLInputElement);
      expect(group?.textContent?.includes("Not installed on this PC")).toBe(showsNote);
    }
  } finally {
    try {
      await page.close();
    } finally {
      fetch.mockRestore();
      if (resizeObserver) Object.defineProperty(globalThis, "ResizeObserver", resizeObserver);
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  }
});
