import { expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { HeaderSessions } from "./HeaderSessions.tsx";

function draw(counts: { working: number; waiting: number; done: number }, onNextWaiting: (() => void) | null): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(HeaderSessions, { counts, onNextWaiting }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

it("draws nothing while every session rests", () => {
  expect(draw({ working: 0, waiting: 0, done: 0 }, null)).toBe("");
});

it("draws a figure per state that has any, the waiting one a button that opens the next", () => {
  const markup = draw({ working: 2, waiting: 1, done: 3 }, () => {});
  expect([...markup.matchAll(/class="header-session-count is-(\w+)"/g)].map((match) => match[1])).toEqual(["working", "blocked", "done"]);
  expect(markup.match(/<button/g)).toHaveLength(1);
  expect(markup).toContain('aria-label="1 waiting for you · Open the next session waiting for you"');
  expect(draw({ working: 0, waiting: 0, done: 1 }, null)).not.toContain("is-working");
});

it("keeps the waiting figure a plain figure when only the selected session waits", () => {
  const markup = draw({ working: 0, waiting: 1, done: 0 }, null);
  expect(markup).not.toContain("<button");
  expect(markup).toContain("1 waiting for you");
});
