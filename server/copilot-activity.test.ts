import { expect, it, mock } from "bun:test";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { CopilotActivity } from "./copilot-activity.ts";

const pane = { pane_id: "p", workspace_id: "w", tab_id: "t", agent: "copilot", agent_status: "idle" } as HerdrPane;
const roster = { all: () => [pane], pane: () => pane, lifetime: () => 1 };
const snapshot: SessionSnapshot = { panes: [pane], agents: [], workspaces: [], tabs: [], layouts: [], protocol: 1, version: "fixture" };

it.skipIf(process.platform !== "linux")("corrects a missed working footer and a quoted one without replacing a prompt or finish", async () => {
  const reads = [true, false, undefined];
  const observer = new CopilotActivity(async () => reads.shift());
  const changed = mock();
  await observer.tick(roster, changed);
  expect(observer.apply(snapshot).panes[0]).toMatchObject({ agent_status: "idle", copilot_processing: true });
  await observer.tick(roster, changed);
  expect(observer.apply(snapshot).panes[0]?.copilot_processing).toBe(false);
  await observer.tick(roster, changed);
  expect(observer.apply(snapshot)).toBe(snapshot);
  expect(changed).toHaveBeenCalledTimes(3);
});

it.skipIf(process.platform !== "linux")("does not apply an outstanding read to a replacement pane", async () => {
  let release!: (busy: boolean) => void;
  const observer = new CopilotActivity(() => new Promise((resolve) => { release = resolve; }));
  const changed = mock();
  const tick = observer.tick(roster, changed);
  observer.forget("p");
  release(true);
  await tick;
  expect(observer.apply(snapshot)).toBe(snapshot);
  expect(changed).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== "linux")("drops a busy sample when observation pauses and resumes with a fresh idle sample", async () => {
  const reads = [true, false];
  const observer = new CopilotActivity(async () => reads.shift());
  const changed = mock();
  await observer.tick(roster, changed);
  await observer.tick(roster, changed, false);
  expect(observer.apply(snapshot)).toBe(snapshot);
  await observer.tick(roster, changed);
  expect(observer.apply(snapshot).panes[0]?.copilot_processing).toBe(false);
});
