import { describe, expect, it } from "bun:test";
import type { RankedFailure, Scan } from "./ci-flakes.ts";
import { ISSUE_TITLE, MAX_ROWS, issueAction, issueBody } from "./ci-flakes-issue.ts";

const stats = { runs: 164, jobs: 682, jobsSkipped: 26, jobsClean: 602, logsRead: 52, runsUnread: 1, logsUnread: 1 };
const scanned = (rows: RankedFailure[], overrides: Partial<Scan> = {}): Scan => ({
  repo: "devswha/ovis", hours: 24, since: "2026-11-16T07:00:00.000Z", until: "2026-11-17T07:00:00.000Z", stats, rows, ...overrides,
});
const failure = (index: number, message = "AssertionError: broken"): RankedFailure => ({
  script: `scripts/s${index}-regression.ts`, site: `scripts/s${index}-regression.ts:${index + 1}`, message,
  failed: index % 2, flaky: 3, runId: 44_000_000_000 + index, branch: `fix/b${index}`, createdAt: "2026-11-17T06:00:00Z",
});
/** The cells of each table row, split on the pipes that are not escaped. */
const tableRows = (body: string): string[][] =>
  body.split("\n").filter((line) => line.startsWith("| ")).map((line) => line.slice(2, -2).split(/(?<!\\)\|/).map((cell) => cell.trim()));
const rankedRows = (body: string): string[][] => tableRows(body).filter((cells) => cells.some((cell) => cell.includes("/actions/runs/")));

describe("CI flakes issue body", () => {
  it("gives the scan's counts and one ranked row per failure with its counts, script, site and most recent run", () => {
    const body = issueBody(scanned([failure(1, "TimeoutError: a | b"), failure(2)]));
    expect(tableRows(body)[1]).toEqual(["164", "682", "602", "52", "26", "1", "1"]);
    expect(body).toContain("2026-11-16T07:00:00.000Z");
    const rows = rankedRows(body);
    expect(rows.map((cells) => cells.length)).toEqual([6, 6]);
    expect(rows.map(([failed, flaky, script, site]) => [failed, flaky, script, site])).toEqual([
      ["1", "3", "`scripts/s1-regression.ts`", "`scripts/s1-regression.ts:2`"], ["0", "3", "`scripts/s2-regression.ts`", "`scripts/s2-regression.ts:3`"],
    ]);
    expect(rows[0]![5]).toContain("(https://github.com/devswha/ovis/actions/runs/44000000001)");
  });

  it("has no ranked rows when nothing failed or needed a second run", () => {
    const body = issueBody(scanned([]));
    expect(tableRows(body)[1]).toEqual(["164", "682", "602", "52", "26", "1", "1"]);
    expect(rankedRows(body)).toEqual([]);
  });

  it("keeps the first rows within GitHub's body limit and counts the rest", () => {
    const rows = Array.from({ length: 500 }, (_, index) => failure(index, "x".repeat(5_000)));
    const body = issueBody(scanned(rows));
    expect(body.length).toBeLessThan(65_536);
    expect(rankedRows(body).map(([, , script]) => script)).toEqual(rows.slice(0, MAX_ROWS).map((row) => `\`${row.script}\``));
    expect(body).toContain(String(500 - MAX_ROWS));
  });
});

describe("CI flakes issue choice", () => {
  it("updates the oldest open issue with the exact title, never a pull request or another title", () => {
    expect(issueAction([
      { number: 40, title: ISSUE_TITLE },
      { number: 7, title: ISSUE_TITLE, pull_request: {} },
      { number: 9, title: `${ISSUE_TITLE} (old)` },
      { number: 12, title: ISSUE_TITLE },
    ])).toEqual({ kind: "update", number: 12 });
  });

  it("creates one when no open issue has the title", () => {
    expect(issueAction([{ number: 7, title: ISSUE_TITLE, pull_request: {} }, { number: 9, title: "CI flakes" }])).toEqual({ kind: "create" });
  });
});
