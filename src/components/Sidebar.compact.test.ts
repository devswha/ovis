import { describe, expect, test } from "bun:test";

import { stateAge } from "./AgentSidebar.tsx";
import { compactBranch, compactWorktreeName } from "./Sidebar.tsx";

describe("compact sidebar rows", () => {
  test("a worktree's name drops herdr's prefix and four-digit hash only when it has both", () => {
    expect(compactWorktreeName("worktree-brave-valley-7fc6")).toBe("brave-valley");
    expect(compactWorktreeName("worktree-devices-ui-live-7fc6")).toBe("devices-ui-live");
    expect(compactWorktreeName("worktree-rapid-harbor")).toBe("worktree-rapid-harbor");
    expect(compactWorktreeName("release-cafe")).toBe("release-cafe");
    expect(compactWorktreeName("worktree-release-coffee")).toBe("worktree-release-coffee");
    expect(compactWorktreeName("dori")).toBe("dori");
  });

  test("the branch at a row's end leaves out the default branch and a feat/-style prefix", () => {
    expect(compactBranch("main")).toBeNull();
    expect(compactBranch("master")).toBeNull();
    expect(compactBranch(null)).toBeNull();
    expect(compactBranch("feat/human-chat")).toBe("human-chat");
    expect(compactBranch("fix/pin/order")).toBe("pin/order");
    expect(compactBranch("integration")).toBe("integration");
  });

  test("a waiting row's time reads in minutes, hours, then days", () => {
    expect(stateAge(30_000)).toBe("<1m");
    expect(stateAge(2 * 60_000)).toBe("2m");
    expect(stateAge(3 * 3_600_000)).toBe("3h");
    expect(stateAge(2 * 86_400_000)).toBe("2d");
  });
});
