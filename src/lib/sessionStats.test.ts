import { describe, expect, it } from "bun:test";
import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { sessionStats } from "./sessionStats.ts";

const user = (ts: string): ConversationTurn => ({ role: "user", ts, parts: [{ kind: "text", text: "ask" }] });
const agent = (ts: string | null, end: string | undefined, parts: ConversationPart[] = [{ kind: "text", text: "answer" }]): ConversationTurn =>
  ({ role: "assistant", ts, ...(end === undefined ? {} : { end_ts: end }), parts });
const goalCall = (name: string, goal: unknown): ConversationPart =>
  ({ kind: "tool", name, summary: name, input: "{}", output: JSON.stringify({ goal }) });
const goal = (objective: string, status: string) => ({ objective, status, tokensUsed: 1200, timeUsedSeconds: 90 });

describe("sessionStats", () => {
  it("adds up the agent turns' recorded durations, skipping a turn whose span is unknown or backwards", () => {
    const stats = sessionStats([
      user("2026-10-26T10:00:00Z"), agent("2026-10-26T10:00:01Z", "2026-10-26T10:01:01Z"),
      user("2026-10-26T11:00:00Z"), agent("2026-10-26T11:00:00Z", "2026-10-26T11:30:00Z"),
      agent(null, "2026-10-26T12:00:00Z"), agent("2026-10-26T13:00:00Z", "2026-10-26T12:00:00Z"), agent("2026-10-26T14:00:00Z", undefined),
    ], true, null);
    expect(stats.workedSeconds).toBe(60 + 30 * 60);
  });

  it("knows no work time before any agent turn has a span", () => {
    expect(sessionStats([user("2026-10-26T10:00:00Z"), agent("2026-10-26T10:00:01Z", undefined)], true, 10).workedSeconds).toBeNull();
  });

  it("passes on whether the turns reach back to the conversation's beginning, and the transcript's size", () => {
    const stats = sessionStats([agent("2026-10-26T10:00:00Z", "2026-10-26T10:00:05Z")], false, 2048);
    expect(stats.complete).toBe(false);
    expect(stats.bytes).toBe(2048);
  });

  it("keeps the goal the latest goal call left, across turns, and drops it when a later call says there is none", () => {
    const set = agent("2026-10-26T10:00:00Z", "2026-10-26T10:00:05Z", [goalCall("create_goal", goal("Ship the metric", "active"))]);
    const later = agent("2026-10-26T11:00:00Z", "2026-10-26T11:00:05Z");
    const updated = agent("2026-10-26T12:00:00Z", "2026-10-26T12:00:05Z", [goalCall("update_goal", goal("Ship the metric", "complete"))]);
    const cleared = agent("2026-10-26T13:00:00Z", "2026-10-26T13:00:05Z", [goalCall("get_goal", null)]);
    expect(sessionStats([set, later], true, null).goal).toMatchObject({ objective: "Ship the metric", status: "active", tokensUsed: 1200, timeUsedSeconds: 90 });
    expect(sessionStats([set, later, updated], true, null).goal?.status).toBe("complete");
    expect(sessionStats([set, later, updated, cleared], true, null).goal).toBeNull();
  });
});
