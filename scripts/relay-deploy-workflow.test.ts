import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface Step { name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; "working-directory"?: string }
interface Workflow {
  on: { push: { branches: string[]; paths: string[] }; workflow_dispatch: unknown };
  jobs: { deploy: { environment: { name: string }; permissions: Record<string, string>; steps: Step[] } };
}

/** The workflow at `path` (default: the committed one), as parsed YAML. */
export const loadWorkflow = (path = process.env.RELAY_DEPLOY_WORKFLOW ?? new URL("../.github/workflows/relay-deploy.yml", import.meta.url).pathname): Workflow =>
  Bun.YAML.parse(readFileSync(path, "utf8")) as Workflow;

test("relay deploy runs on a push to main touching relay/ and by hand", () => {
  const { on } = loadWorkflow();
  expect(on.push.branches).toEqual(["main"]);
  expect(on.push.paths).toEqual(["relay/**"]);
  expect("workflow_dispatch" in on).toBe(true);
});

test("relay deploy job waits in the production environment with read-only permissions", () => {
  const { deploy } = loadWorkflow().jobs;
  expect(deploy.environment.name).toBe("production");
  expect(deploy.permissions).toEqual({ contents: "read" });
});

test("the deploy is skipped without the secrets and the health check follows it", () => {
  const { steps } = loadWorkflow().jobs.deploy;
  const guard = steps.findIndex((step) => step.env?.HAS_CLOUDFLARE_API_TOKEN !== undefined && step.env?.HAS_CLOUDFLARE_ACCOUNT_ID !== undefined);
  const deploy = steps.findIndex((step) => step.run?.includes("wrangler deploy"));
  const health = steps.findIndex((step) => step.run?.includes("curl") && step.run.includes("https://relay.ovis.sh/health"));
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(deploy).toBeGreaterThan(guard);
  expect(health).toBeGreaterThan(deploy);
  const guardId = (steps[guard] as Step & { id?: string }).id;
  expect(steps[deploy]!.if).toContain(`steps.${guardId}.outputs.ready == 'true'`);
  expect(steps[deploy]!["working-directory"]).toBe("relay");
  expect(steps[deploy]!.env?.CLOUDFLARE_API_TOKEN).toContain("secrets.CLOUDFLARE_API_TOKEN");
  expect(steps[deploy]!.env?.CLOUDFLARE_ACCOUNT_ID).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
  expect(steps[health]!.if).toContain(`steps.${guardId}.outputs.ready == 'true'`);
});

test("the relay's own tests run before the deploy", () => {
  const { steps } = loadWorkflow().jobs.deploy;
  const tests = steps.findIndex((step) => step.run === "bun test ./relay");
  expect(tests).toBeGreaterThanOrEqual(0);
  expect(tests).toBeLessThan(steps.findIndex((step) => step.run?.includes("wrangler deploy")));
});
