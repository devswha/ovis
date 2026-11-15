import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Check } from "lucide-react";
import { paneMenuItems, tabMenuHeader } from "./tabMenus.tsx";
import type { RowMenuItem } from "../components/RowMenu.tsx";

const items = ["rename", "close", "shared", "split-right", "zoom", "recover"].map((id): RowMenuItem => ({ id, label: id, icon: Check, run() {} }));
const tabs: RowMenuItem[] = [{ id: "shared", label: "shared", icon: Check, run() {} }];

it("defaults to upstream pane actions, including Close pane in a one-pane tab", () => {
  expect(paneMenuItems(items, tabs, false, true, false, false).map((item) => item.id)).toEqual(["rename", "close", "split-right", "zoom", "recover"]);
  expect(paneMenuItems(items, tabs, false, true, true, false).map((item) => item.id)).toEqual(["rename", "close", "recover"]);
});

it("preserves the compact fork menu without losing recovery or split-pane close", () => {
  expect(paneMenuItems(items, tabs, true, true, false, false).map((item) => item.id)).toEqual(["shared", "split-right", "zoom", "recover"]);
  expect(paneMenuItems(items, tabs, true, false, true, true).map((item) => item.id)).toEqual(["rename", "close", "shared", "zoom", "recover"]);
});

it("uses upstream menu headers by default and optional location context on compact menus", () => {
  const upstream = tabMenuHeader(false, "Tab 1", "repo · main", false, false);
  expect(upstream.subtitle).toBeUndefined();
  expect(renderToStaticMarkup(upstream.header!)).toContain("tab-strip-menu-target");
  expect(renderToStaticMarkup(upstream.header!)).toContain("Tab 1");
  const fork = tabMenuHeader(true, "Tab 1", "repo · main", false, false);
  expect(fork.subtitle).toBe("repo · main");
  expect(renderToStaticMarkup(fork.header!)).toContain("tab-menu-place");
  expect(tabMenuHeader(true, "Tab 1", "repo", false, true).header).toBeUndefined();
  expect(tabMenuHeader(true, "Move Tab 1", "repo", true, false).subtitle).toBeUndefined();
});
