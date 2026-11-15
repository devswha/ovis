import { afterEach, beforeEach, expect, it, jest } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { showEnrollmentNotice } from "../lib/relay/enrollmentNotice.ts";
import { createShellTestPage } from "../lib/relay/shellTestPage.fixture.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { OpenPcEnrollmentNotice } from "./EnrollmentNotice.tsx";

// each test has a page of its own, with what SettingsProvider reads (its computed style) and React's act flag, all put
// back after it; the notice (and its countdown's timer) is taken away after each test
let page: ReturnType<typeof createShellTestPage>;
const saved = new Map<string, PropertyDescriptor | undefined>();
let tree: ReactTestRenderer | undefined;
beforeEach(() => {
  page = createShellTestPage();
  for (const key of ["getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});
afterEach(() => {
  if (tree) act(() => { tree?.unmount(); });
  tree = undefined;
  showEnrollmentNotice(null);
  jest.useRealTimers();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
  page.dispose();
});

const provided = (node: ReturnType<typeof createElement>) => createElement(SettingsProvider, { children: node });
/** The open PC's notice as the page draws it, in `language` (the page's own navigator, put back with the page). */
const markup = (language: "en" | "ko" | "ja" | "zh" = "en"): string => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: [language] } });
  return renderToStaticMarkup(provided(createElement(OpenPcEnrollmentNotice)));
};
const draw = (): void => { act(() => { tree?.unmount(); tree = create(provided(createElement(OpenPcEnrollmentNotice))); }); };

/** What a program reads of the drawn notice: its kind, seconds and reason, whether its line names the seconds, and its dismiss control. */
const read = (html: string) => {
  const line = /<div[^>]*data-enrollment-notice=""[^>]*>/.exec(html)?.[0] ?? "";
  const attribute = (name: string) => new RegExp(` ${name}="([^"]*)"`).exec(line)?.[1] ?? null;
  const seconds = attribute("data-seconds");
  return {
    kind: attribute("data-kind"), seconds, reason: attribute("data-reason"),
    named: seconds !== null && (/<span>([^<]*)<\/span>/.exec(html)?.[1] ?? "").includes(seconds),
    dismiss: html.includes('data-action="dismiss-enrollment-notice"'),
  };
};

it.each(["en", "ko", "ja", "zh"] as const)("says in %s, on one line that cannot be dismissed, how many seconds are left of the account service's wait", (language) => {
  showEnrollmentNotice({ kind: "waiting", seconds: 42 });
  expect(read(markup(language))).toEqual({ kind: "waiting", seconds: "42", reason: null, named: true, dismiss: false });
  showEnrollmentNotice(null);
  expect(markup(language)).toBe("");
});

it("counts the wait down once a second where it is fed, so a notice drawn again shows what is left, and a new wait starts again", () => {
  jest.useFakeTimers();
  const seconds = () => tree?.root.findByProps({ "data-kind": "waiting" }).props["data-seconds"];
  showEnrollmentNotice({ kind: "waiting", seconds: 3 });
  draw();
  expect(seconds()).toBe(3);
  act(() => { jest.advanceTimersByTime(1_000); });
  expect(seconds()).toBe(2);
  // drawn again (another layout, a remount): still what is left
  draw();
  expect(seconds()).toBe(2);
  act(() => { jest.advanceTimersByTime(5_000); });
  expect(seconds()).toBe(0);
  act(() => { showEnrollmentNotice({ kind: "waiting", seconds: 3 }); });
  expect(seconds()).toBe(3);
});

it("is taken away only by the enrollment that showed it, not after another one has shown its own", () => {
  const first = showEnrollmentNotice({ kind: "waiting", seconds: 5 });
  const second = showEnrollmentNotice({ kind: "waiting", seconds: 7 });
  first();
  expect(markup()).toContain('data-seconds="7"');
  second();
  expect(markup()).toBe("");
});

it("carries the reason it is given for a stopped enrollment, and only that notice can be dismissed, which takes it away", () => {
  showEnrollmentNotice({ kind: "failed", reason: "test-reason-token" });
  expect(read(markup())).toEqual({ kind: "failed", seconds: null, reason: "test-reason-token", named: false, dismiss: true });
  draw();
  act(() => { tree?.root.findByProps({ "data-action": "dismiss-enrollment-notice" }).props.onClick(); });
  expect(tree?.toJSON()).toBeNull();
});
