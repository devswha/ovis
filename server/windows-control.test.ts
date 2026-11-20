import { expect, it } from "bun:test";
import { knownWindowsControl } from "./windows-control.ts";

it("keeps the fixed mirror on unknown, mismatched and non-native stream pairs", () => {
  const daemon = { version: "0.9.5", protocol: 22 };
  expect(knownWindowsControl("win32", daemon, "herdr 0.9.5\r\n")).toBe(true);
  expect(knownWindowsControl("win32", daemon, "herdr 0.9.3")).toBe(false);
  expect(knownWindowsControl("win32", { ...daemon, protocol: 23 }, "herdr 0.9.5")).toBe(false);
  expect(knownWindowsControl("win32", { ...daemon, version: "0.9.6" }, "herdr 0.9.6")).toBe(false);
  expect(knownWindowsControl("win32", { ...daemon, runtime: "herdr-core" }, "herdr 0.9.5")).toBe(false);
  expect(knownWindowsControl("linux", daemon, "herdr 0.9.5")).toBe(false);
});
