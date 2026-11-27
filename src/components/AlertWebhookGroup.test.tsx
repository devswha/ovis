import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { AlertWebhookView } from "../../shared/alert-webhook.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AlertWebhookGroup } from "./AlertWebhookGroup.tsx";


let page: Page;
let resizeObserver: PropertyDescriptor | undefined;
let held: AlertWebhookView;
let puts: unknown[];
let refuse: boolean;

beforeEach(() => {
  puts = [];
  refuse = false;
  held = { configured: true, preset: "ntfy", target: "https://ntfy.sh/…pic", chat_id: null, alerts: { input: false, done: "long" }, link: true, reachable_link: true, last_success_at: null, last_failure_at: null, last_error: null };
  page = openPage("http://127.0.0.1:7421/");
  resizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: page.window.ResizeObserver });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7421").pathname;
    if (path !== "/api/alerts/webhook") return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    if ((init?.method ?? "GET") === "GET") return Response.json(held);
    puts.push(JSON.parse(String(init?.body)));
    if (refuse) return Response.json({ error: { code: "webhook_failed", message: "the destination answered 500" } }, { status: 500 });
    const { alerts = held.alerts, link = held.link } = JSON.parse(String(init?.body)) as Partial<AlertWebhookView>;
    held = { ...held, alerts, link };
    return Response.json(held);
  };
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
});

afterEach(async () => {
  await page.close();
  if (resizeObserver) Object.defineProperty(globalThis, "ResizeObserver", resizeObserver);
  else Reflect.deleteProperty(globalThis, "ResizeObserver");
  mock.restore();
});

const settle = () => act(async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve(); });

async function open(): Promise<{ switchOf: (name: string) => HTMLButtonElement; text: () => string }> {
  await page.render(createElement(SettingsProvider, null, createElement(AlertWebhookGroup)));
  await settle();
  return {
    switchOf: (name) => page.one(`button[role="switch"][aria-label="${name}"]`),
    text: () => page.container.textContent ?? "",
  };
}

describe("a saved destination's alert switch", () => {
  it("keeps a choice the server took", async () => {
    const view = await open();
    expect(view.switchOf("Needs input").getAttribute("aria-checked")).toBe("false");
    await act(async () => { view.switchOf("Needs input").click(); });
    await settle();
    expect(puts).toEqual([{ preset: "ntfy", alerts: { input: true, done: "long" } }]);
    expect(view.switchOf("Needs input").getAttribute("aria-checked")).toBe("true");
    expect(view.text()).toContain("Saved on this PC");
  });

  it("saves the link turned off, and stops warning about a link a phone cannot open (#3854)", async () => {
    held = { ...held, reachable_link: false };
    const view = await open();
    expect(view.text()).toContain("Messages have no link a phone can open yet.");
    // an address typed but not saved stays out of a switch's save
    page.one<HTMLInputElement>('input[aria-label="Webhook URL"]').value = "https://ntfy.sh/draft";
    await act(async () => { view.switchOf("Link to the pane").click(); });
    await settle();
    expect(puts).toEqual([{ preset: "ntfy", link: false }]);
    expect(view.switchOf("Link to the pane").getAttribute("aria-checked")).toBe("false");
    expect(view.text()).not.toContain("Messages have no link a phone can open yet.");
  });

  it("offers no link switch to a PC that does not know it", async () => {
    const { link: _link, ...older } = held;
    held = older as AlertWebhookView;
    const view = await open();
    expect(page.container.querySelectorAll('button[role="switch"][aria-label="Link to the pane"]')).toHaveLength(0);
    expect(view.switchOf("Needs input").getAttribute("aria-checked")).toBe("false");
  });

  it("goes back to the value the server holds when it refuses the save, and says why (G-010)", async () => {
    refuse = true;
    const view = await open();
    await act(async () => { view.switchOf("Needs input").click(); });
    await settle();
    expect(puts).toHaveLength(1);
    expect(view.switchOf("Needs input").getAttribute("aria-checked")).toBe("false");
    await act(async () => { view.switchOf("Link to the pane").click(); });
    await settle();
    expect(puts).toHaveLength(2);
    expect(view.switchOf("Link to the pane").getAttribute("aria-checked")).toBe("true");
    expect(view.text()).toContain("the destination answered 500");
    expect(view.text()).not.toContain("Saved on this PC");
    expect(page.container.innerHTML).toContain('role="alert"');
  });
});
