import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";

import type { AppActions } from "../lib/actions.ts";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { SecurityFacts } from "../lib/useAccess.ts";
import type { UpdatesModel } from "../lib/updates.ts";
import { SettingsDialog } from "./SettingsDialog.tsx";

describe("a link to a group that comes late (#3459)", () => {
  const globals = ["ResizeObserver", "MutationObserver", "CSS", "HTMLElement", "__HERDR_TEST_HOOKS__"] as const;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let page: Page;
  let fetch: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  const held: (() => void)[] = [];

  beforeEach(async () => {
    page = openPage();
    for (const name of globals) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "__HERDR_TEST_HOOKS__" ? false : page.window[name] });
    }
    // the agents' catalog is held, then fails: Claude Code's group is drawn only then
    fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
      if (new URL(input instanceof Request ? input.url : String(input), "http://localhost").pathname.endsWith("/agent-catalog")) {
        return new Promise<Response>((resolve) => held.push(() => resolve(new Response(null, { status: 500 }))));
      }
      return new Response(null, { status: 404 });
    }, { preconnect: globalThis.fetch.preconnect }));
    const noop = () => {};
    await page.render(<SettingsProvider>
      <SettingsDialog open linkPage="agents" linkSection="agent-claude" onClose={noop} onUsageLogin={noop} onOpenPane={noop}
        actions={{} as AppActions} updates={{} as UpdatesModel} auth={null} herdrVersion={null} security={{} as SecurityFacts}
        onEnableNotifications={async () => ({ ok: true }) as never} saveError={null} savePaused={false} saveRetrying={false} onRetrySave={noop} />
    </SettingsProvider>);
  });

  afterEach(async () => {
    try {
      await page.close();
    } finally {
      fetch.mockRestore();
      held.length = 0;
      for (const [name, was] of saved) {
        if (was) Object.defineProperty(globalThis, name, was);
        else Reflect.deleteProperty(globalThis, name);
      }
      saved.clear();
    }
  });

  const search = () => document.querySelector<HTMLInputElement>("input[type='search']")!;
  const focused = () => document.activeElement?.getAttribute("data-section") ?? document.activeElement?.getAttribute("aria-label");
  const groupComes = async (): Promise<boolean> => {
    await act(async () => { for (const fail of held.splice(0)) fail(); });
    return document.querySelector(".settings-body:not([hidden]) [data-section='agent-claude']") !== null;
  };

  it("focuses the group once it is drawn, while the reader has done nothing", async () => {
    expect(document.querySelector("[data-section='agent-claude']") === null).toBe(true);
    expect(await groupComes()).toBe(true);
    expect(focused()).toBe("agent-claude");
  });

  it("leaves the focus in the search box the reader moved it to", async () => {
    await act(async () => search().focus());
    expect(await groupComes()).toBe(true);
    expect(focused()).toBe("Search settings");
  });
});
