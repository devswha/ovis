import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_CHROME_TMPDIR, checkChromeTmpdir } from "./chrome-path.ts";

const of = (length: number): string => `/${"x".repeat(length - 1)}`;

test("a TMPDIR Chromium's socket fits under passes, one character longer is refused with a fix", () => {
  expect(() => checkChromeTmpdir(of(MAX_CHROME_TMPDIR), "linux")).not.toThrow();
  expect(() => checkChromeTmpdir(of(MAX_CHROME_TMPDIR + 1), "linux")).toThrow(/TMPDIR is 62 characters .*TMPDIR=\/var\/tmp\/ovis-ui/);
});

test("every script that launches Chromium checks TMPDIR first", () => {
  const root = join(import.meta.dir, "..");
  const unchecked = [...new Bun.Glob("{scripts,src,server}/**/*.{ts,tsx}").scanSync(root)]
    .filter((file) => !file.endsWith(".test.ts"))
    .filter((file) => {
      const source = readFileSync(join(root, file), "utf8");
      return /chromium\.(launch|launchPersistentContext)\(/.test(source) && !/chromePath\(\)|checkChromeTmpdir\(\)/.test(source);
    });
  expect(unchecked, "launch through chromePath(), or call checkChromeTmpdir() before chromium.launch").toEqual([]);
});

test("only Linux is checked", () => {
  expect(() => checkChromeTmpdir(of(120), "darwin")).not.toThrow();
  expect(() => checkChromeTmpdir(of(120), "win32")).not.toThrow();
});
