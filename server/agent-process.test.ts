import { describe, expect, it } from "bun:test";
import { agentProcessInFront } from "./agent-process.ts";

const info = (...foreground: { pid: number; argv: string[] }[]) => ({ pane_id: "fixture", foreground_processes: foreground.map((entry) => ({ ...entry, name: entry.argv[0]! })) });
// a launcher that does not exec its agent stays listed before the native binary it started
const launcher = { pid: 100, argv: ["node", "/opt/fixture/bin/claude"] };
const native = { pid: 101, argv: ["/opt/fixture/native/claude"] };

describe("the agent process in front", () => {
  it("takes the agent's native binary over a launcher listed before it", () => {
    expect(agentProcessInFront(info(launcher, native), "claude")?.pid).toBe(native.pid);
  });

  it("keeps the bound process while herdr lists it, the launcher a launch reported included", () => {
    expect(agentProcessInFront(info(launcher, native), "claude", launcher.pid)?.pid).toBe(launcher.pid);
  });

  it("takes the agent's own process once the bound one is gone", () => {
    expect(agentProcessInFront(info(launcher, { ...native, pid: 102 }), "claude", native.pid)?.pid).toBe(102);
  });

  it("names none where herdr names no agent or none of its programs runs", () => {
    expect(agentProcessInFront(info(launcher, native), null)).toBeNull();
    expect(agentProcessInFront(info({ pid: 7, argv: ["pwsh.exe"] }), "codex")).toBeNull();
    expect(agentProcessInFront(undefined, "claude")).toBeNull();
  });
});
