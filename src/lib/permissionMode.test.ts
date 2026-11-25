import { expect, it } from "bun:test";
import { permissionModeIcon, permissionModeLabel } from "./permissionMode.ts";

const t = (key: string): string => `<${key}>`;

it("names each of Claude Code's modes but its default, and an unknown one as it came", () => {
  expect([undefined, "default"].map((mode) => permissionModeLabel(mode, t))).toEqual([null, null]);
  expect(["plan", "acceptEdits", "auto", "bypassPermissions", "dontAsk"].map((mode) => permissionModeLabel(mode, t)))
    .toEqual(["<Plan mode>", "<Accept edits>", "<Auto mode>", "<Bypass permissions>", "<Don't ask>"]);
  expect(permissionModeLabel("someNewMode", t)).toBe("someNewMode");
});

it("gives each mode a mark of its own for a row with no room for its name", () => {
  const marks = ["plan", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "someNewMode"].map(permissionModeIcon);
  expect(new Set(marks).size).toBe(marks.length);
});
