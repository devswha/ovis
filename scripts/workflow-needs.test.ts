import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow, root, type Workflow } from "./shell-workflow-rules.ts";

const dir = join(root, ".github/workflows");
const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();

/**
 * A job-level `if` that calls always(), cancelled() or failure() replaces GitHub's implied `success()`:
 * the job says for itself when it runs. Naming success() changes nothing: it is the implied rule written out.
 */
const decides = (condition: unknown): boolean => /\b(always|cancelled|failure)\s*\(/i.test(String(condition ?? ""));

/**
 * The jobs that wait for a job deciding for itself without deciding for themselves. A job whose `if`
 * names no status function runs only when no job its `needs` lead back to failed or was skipped,
 * however far back. Behind a deciding job that is the wrong rule: the deciding job ran and passed
 * although one before it was skipped, and the job after it is skipped all the same.
 */
function skippedBehindDecidingJobs(workflow: Workflow): string[] {
  const needs = (id: string): string[] => [workflow.jobs[id]?.needs ?? []].flat();
  return Object.keys(workflow.jobs).filter((id) => {
    if (decides(workflow.jobs[id]!.if)) return false;
    const seen = new Set<string>();
    // true once a job is reached through one that decides for itself
    const reaches = (from: string, behind: boolean): boolean => needs(from).some((need) => {
      if (behind) return true;
      if (seen.has(need)) return false;
      seen.add(need);
      return reaches(need, decides(workflow.jobs[need]?.if));
    });
    return reaches(id, false);
  });
}

const workflowOf = (jobs: Workflow["jobs"]): Workflow => ({ on: {}, jobs });

test("a job behind one that decides for itself is found, however far behind, unless it decides too", () => {
  const beta = (publish: string | undefined) => workflowOf({
    host: { if: "needs.pick.outputs.host == 'build'" },
    tag: { needs: "host", if: "always() && needs.pick.outputs.tag != ''" },
    build: { needs: ["tag"], if: "always() && needs.tag.result == 'success'" },
    publish: { needs: ["build"], ...(publish === undefined ? {} : { if: publish }) },
    after: { needs: "publish" },
  });
  expect(skippedBehindDecidingJobs(beta(undefined))).toEqual(["publish", "after"]);
  expect(skippedBehindDecidingJobs(beta("needs.build.result == 'success'"))).toEqual(["publish", "after"]);
  expect(skippedBehindDecidingJobs(beta("success() && needs.build.result == 'success'"))).toEqual(["publish", "after"]);
  expect(skippedBehindDecidingJobs(beta("${{ !Cancelled() && needs.build.result == 'success' }}"))).toEqual(["after"]);
  expect(skippedBehindDecidingJobs(beta("${{ !cancelled() && needs.build.result == 'success' }}"))).toEqual(["after"]);
  // a deciding job with nothing before it hides nothing, and a plain chain is GitHub's own rule
  expect(skippedBehindDecidingJobs(workflowOf({ first: { if: "always()" }, second: { needs: "first" }, third: { needs: ["second"] } }))).toEqual([]);
  expect(skippedBehindDecidingJobs(workflowOf({ first: { if: "inputs.tag != ''" }, second: { needs: "first" } }))).toEqual([]);
});

test("no workflow leaves a job to be skipped behind one that ran", () => {
  const found = files.flatMap((file) => skippedBehindDecidingJobs(parseWorkflow(join(dir, file))).map((job) => `${file}: ${job}`));
  expect(found).toEqual([
    // its own condition leaves out the pull request, the one event that skips the gate before its build
    "windows-app.yml: attach",
  ]);
});

test("Beta uploads the desktop builds whenever they passed, whatever became of the host's own jobs", () => {
  const beta = parseWorkflow(join(dir, "beta.yml"));
  // host-publish has no condition: it is skipped with host-build, every time the host was built before
  expect(beta.jobs["host-build"]!.if).toBe("needs.pick.outputs.host == 'build'");
  expect(beta.jobs["host-publish"]!.if).toBeUndefined();
  const publish = beta.jobs["desktop-publish"]!;
  expect(publish.needs).toEqual(["pick", "desktop"]);
  expect(publish.if).toBe("${{ !cancelled() && needs.desktop.result == 'success' }}");
  // the last job: nothing waits for it
  expect(Object.entries(beta.jobs).filter(([, job]) => [job.needs ?? []].flat().includes("desktop-publish"))).toEqual([]);
});
