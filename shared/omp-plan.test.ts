import { describe, expect, it } from "bun:test";
import { OMP_PLAN_PLACEHOLDER, ompPlanEditTarget, ompPlanName, planNoticeOf, planNoticeSource } from "./omp-plan.ts";

describe("ompPlanName", () => {
  it("names the plan files omp keeps: `local://<slug>-plan.md`, and `PLAN.md` before a slug is proposed", () => {
    expect(ompPlanName("local://omp-proto-readme-plan.md")).toEqual({ file: "omp-proto-readme-plan.md", slug: "omp-proto-readme" });
    expect(ompPlanName("local://a_B-9-plan.md")).toEqual({ file: "a_B-9-plan.md", slug: "a_B-9" });
    // the slug itself may end in `-plan`
    expect(ompPlanName("local://my-plan-plan.md")).toEqual({ file: "my-plan-plan.md", slug: "my-plan" });
    expect(ompPlanName(OMP_PLAN_PLACEHOLDER)).toEqual({ file: "PLAN.md", slug: null });
  });

  it("refuses every other path: no folder, no climbing, no range, no other file or scheme", () => {
    for (const path of [
      "local://../x-plan.md", "local://a/b-plan.md", "local://..%2fx-plan.md", "local://x-plan.md:14-22", "local://x-plan.md.bak",
      "local://-plan.md", "local://x-plan.MD", "local://plan.md", "local://PLAN.md/", "local://notes.md", "local://x y-plan.md",
      "/home/u/.omp/x-plan.md", "x-plan.md", "LOCAL://x-plan.md", "file://x-plan.md", "local://x\n-plan.md", "local://".concat("a".repeat(101), "-plan.md"), "",
    ]) expect(ompPlanName(path), path).toBeNull();
    for (const value of [undefined, null, 5, {}, ["local://x-plan.md"]]) expect(ompPlanName(value)).toBeNull();
  });
});

describe("ompPlanEditTarget", () => {
  it("reads the plan an omp edit script edits from its first header", () => {
    expect(ompPlanEditTarget("[local://omp-proto-readme-plan.md#F920]\nPUT >15:\n+1. Write")).toBe("local://omp-proto-readme-plan.md");
    expect(ompPlanEditTarget("[local://PLAN.md]\nCUT 3")).toBe("local://PLAN.md");
  });

  it("reads none from a script of another file, a header past its first line or no header", () => {
    expect(ompPlanEditTarget("[src/app.ts#A1B2]\nPUT 1:\n+x")).toBeNull();
    expect(ompPlanEditTarget("PUT 1:\n+[local://x-plan.md#F920]")).toBeNull();
    expect(ompPlanEditTarget("\n[local://x-plan.md#F920]")).toBeNull();
    expect(ompPlanEditTarget("[local://../x-plan.md#F920]")).toBeNull();
  });
});

describe("plan notice sources", () => {
  it("carry the kind and the slug, and read back", () => {
    expect(planNoticeSource("ready", "omp-proto-readme")).toBe("plan-ready:omp-proto-readme");
    expect(planNoticeSource("paused", null)).toBe("plan-paused");
    for (const kind of ["on", "ready", "paused", "off", "approved"] as const) {
      expect(planNoticeOf(planNoticeSource(kind, "s-1"))).toEqual({ kind, slug: "s-1" });
      expect(planNoticeOf(planNoticeSource(kind, null))).toEqual({ kind, slug: null });
    }
  });

  it("read nothing from another notice's source", () => {
    for (const source of [undefined, "", "async-result", "goal-continuation", "peer:t7", "plan-unknown", "plan-ready:", "plan-ready:a b", "plan-ready:a:b", "xplan-on"]) {
      expect(planNoticeOf(source), String(source)).toBeNull();
    }
  });
});
