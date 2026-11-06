import { expect, it } from "bun:test";
import type { MovePane, MovePlan } from "../shared/runtime-move.ts";
import { sameShape } from "./runtime-move-service.ts";

const plan = (panes: MovePane[]): MovePlan => ({ ready: true, revision: "r", workspaces: [{ workspace_id: "w1", name: "ovis", tabs: [{ tab_id: "t1", name: "1", root: { pane: "a" } }] }], panes });
const shown = plan([
  { pane_id: "a", cwd: "/a", name: null, verdict: { kind: "busy", reason: "agent_working", agent: "codex", command: null } },
  { pane_id: "b", cwd: "/b", name: null, verdict: { kind: "shell" } },
]);

it("lets a waiting move go only when what was shown is what moves", () => {
  // the busy Codex finished its turn: it becomes its own conversation
  const done = plan([{ ...shown.panes[0]!, verdict: { kind: "resume", agent: "codex", session_id: "s", argv: ["codex", "resume", "s"], ended: false } }, shown.panes[1]!]);
  expect(sameShape(shown, done)).toBe(true);
  // another agent took the pane, it moved to another folder, or a pane came that was never shown
  expect(sameShape(shown, plan([{ ...done.panes[0]!, verdict: { kind: "fresh", agent: "claude" } }, shown.panes[1]!]))).toBe(false);
  expect(sameShape(shown, plan([{ ...done.panes[0]!, cwd: "/elsewhere" }, shown.panes[1]!]))).toBe(false);
  expect(sameShape(shown, plan([...done.panes, { pane_id: "c", cwd: "/c", name: null, verdict: { kind: "shell" } }]))).toBe(false);
  // the person ended an agent that waited for them: a shell now, or its conversation to reopen
  const waited = plan([{ pane_id: "a", cwd: "/a", name: null, verdict: { kind: "needs_you", agent: "copilot" } }, shown.panes[1]!]);
  expect(sameShape(waited, plan([{ ...waited.panes[0]!, verdict: { kind: "shell" } }, shown.panes[1]!]))).toBe(true);
  expect(sameShape(waited, plan([{ ...waited.panes[0]!, verdict: { kind: "resume", agent: "copilot" as never, session_id: "s", argv: ["copilot"], ended: true } }, shown.panes[1]!]))).toBe(true);
});
