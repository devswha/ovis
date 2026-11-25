import { expect, it } from "bun:test";
import { permissionModeLabel } from "./permissionMode.ts";

const t = (key: string): string => `<${key}>`;

it("names each of Claude Code's modes but its default, and an unknown one as it came", () => {
  expect([undefined, "default"].map((mode) => permissionModeLabel(mode, t))).toEqual([null, null]);
  expect(["plan", "acceptEdits", "auto", "bypassPermissions", "dontAsk"].map((mode) => permissionModeLabel(mode, t)))
    .toEqual(["<Plan mode>", "<Accept edits>", "<Auto mode>", "<Bypass permissions>", "<Don't ask>"]);
  expect(permissionModeLabel("someNewMode", t)).toBe("someNewMode");
});
