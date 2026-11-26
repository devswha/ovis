import { expect, test } from "bun:test";
import { MAX_CHROME_TMPDIR, checkChromeTmpdir } from "./chrome-path.ts";

const of = (length: number): string => `/${"x".repeat(length - 1)}`;

test("a TMPDIR Chromium's socket fits under passes, one character longer is refused with a fix", () => {
  expect(() => checkChromeTmpdir(of(MAX_CHROME_TMPDIR), "linux")).not.toThrow();
  expect(() => checkChromeTmpdir(of(MAX_CHROME_TMPDIR + 1), "linux")).toThrow(/TMPDIR is 62 characters .*TMPDIR=\/var\/tmp\/ovis-ui/);
});

test("only Linux is checked", () => {
  expect(() => checkChromeTmpdir(of(120), "darwin")).not.toThrow();
  expect(() => checkChromeTmpdir(of(120), "win32")).not.toThrow();
});
