import { afterEach, expect, it } from "bun:test";

import { openPullLink, pullLink, setPullLinkOpener } from "./pullLinks.ts";

afterEach(() => setPullLinkOpener(null));
const click = (extra: Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => {
  const event = { button: 0, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, prevented: false, preventDefault() { event.prevented = true; }, ...extra };
  return event;
};

it("names a pull request's link and nothing else", () => {
  expect(pullLink("https://github.com/BANX-HOG/banx-app/pull/29")).toEqual({ repository: "BANX-HOG/banx-app", number: 29 });
  expect(pullLink("https://github.com/o/r/pull/7/files#diff-1")).toEqual({ repository: "o/r", number: 7 });
  expect(pullLink("https://github.com/o/r/issues/7")).toBeNull();
  expect(pullLink("https://github.com/o/r/pull/7x")).toBeNull();
  expect(pullLink("https://example.com/o/r/pull/7")).toBeNull();
});

it("a plain click opens the page in Ovis; a modified click, no opener or the feature off leaves it to the browser", () => {
  const opened: string[] = [];
  const href = "https://github.com/o/r/pull/7";
  expect(openPullLink(click(), href, true)).toBe(false);
  setPullLinkOpener((repository, number) => opened.push(`${repository}#${number}`));
  expect(openPullLink(click({ ctrlKey: true }), href, true)).toBe(false);
  expect(openPullLink(click(), href, false)).toBe(false);
  const plain = click();
  expect(openPullLink(plain, href, true)).toBe(true);
  expect(plain.prevented).toBe(true);
  expect(opened).toEqual(["o/r#7"]);
});
