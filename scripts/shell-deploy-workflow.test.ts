import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

interface Step { name?: string; id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string> }
interface Job { needs?: string | string[]; if?: string; env?: Record<string, string>; "runs-on"?: unknown; environment?: string | { name: string }; permissions?: Record<string, string>; "timeout-minutes"?: number; steps: Step[] }
interface Workflow { on: { workflow_dispatch: unknown; push?: unknown }; env?: Record<string, string>; jobs: Record<string, Job> }

/** The workflow at `path` (default: the committed one), as parsed YAML. */
export const loadWorkflow = (path = process.env.SHELL_DEPLOY_WORKFLOW ?? new URL("../.github/workflows/release.yml", import.meta.url).pathname): Workflow =>
  Bun.YAML.parse(readFileSync(path, "utf8")) as Workflow;

const job = (): Job => loadWorkflow().jobs["shell-deploy"]!;
const attachJob = (): Job => loadWorkflow().jobs["shell-attach"]!;
const indexOf = (predicate: (step: Step) => boolean): number => job().steps.findIndex(predicate);

test("the shell deploys after publish, from the release workflow on main only, never on a tag push", () => {
  const workflow = loadWorkflow();
  expect(job().needs).toBe("publish");
  expect(job().if).toBe("github.repository == 'devswha/ovis' && github.ref == 'refs/heads/main'");
  expect("push" in workflow.on).toBe(false);
});

test("the job builds the release tag's checkout and refuses any other commit", () => {
  const { steps } = job();
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"))!;
  expect(checkout.with?.ref).toBe("refs/tags/v${{ inputs.version }}");
  expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
  const gate = steps.find((step) => step.name === "Require the release tag's commit")!;
  expect(gate.run).toContain('git show-ref --verify --quiet "refs/tags/$RELEASE_TAG"');
  expect(gate.run).toContain('test "$(git rev-parse HEAD)" = "$RELEASE_SHA"');
  const build = indexOf((step) => step.run === "bun run build:shell");
  expect(steps.indexOf(gate)).toBeLessThan(build);
  const required = indexOf((step) => step.name === "Require the built shell");
  expect(required).toBe(build + 1);
  expect(steps[required]!.run).toContain("index.html build.json");
  expect(steps[required]!.run).toContain("exit 1");
});

test("it waits in production on a GitHub-hosted runner, reading only, with pinned actions and wrangler", () => {
  const environment = job().environment;
  expect(typeof environment === "string" ? environment : environment?.name).toBe("production");
  expect(job()["runs-on"]).toBe("ubuntu-24.04");
  expect(job().permissions).toEqual({ contents: "read" });
  expect(job()["timeout-minutes"]).toBeGreaterThan(0);
  for (const step of [...job().steps, ...attachJob().steps]) if (step.uses && !step.uses.startsWith("./")) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
  expect(job().steps.some((step) => /bunx wrangler@\d+\.\d+\.\d+ pages deploy /.test(step.run ?? ""))).toBe(true);
});

test("only the attach job may write, and it holds no Cloudflare secret", () => {
  const workflow = loadWorkflow();
  expect(attachJob().needs).toBe("shell-deploy");
  expect(attachJob().if).toBeUndefined();
  expect(attachJob().permissions).toEqual({ contents: "write" });
  expect(attachJob().environment).toBeUndefined();
  for (const [name, candidate] of Object.entries(workflow.jobs)) {
    if (name === "shell-deploy") continue;
    expect(JSON.stringify(candidate)).not.toContain("CLOUDFLARE_");
  }
});

test("only the deploy step receives the Cloudflare secrets; others may only test that they are set", () => {
  const secret = "secrets.CLOUDFLARE_";
  expect(JSON.stringify(loadWorkflow().env ?? {})).not.toContain(secret);
  expect(JSON.stringify(job().env ?? {})).not.toContain(secret);
  const deploy = indexOf((step) => step.run?.includes("pages deploy dist-shell") === true);
  expect(deploy).toBeGreaterThanOrEqual(0);
  job().steps.forEach((step, index) => {
    if (index !== deploy) expect(JSON.stringify(step).replace(/secrets\.CLOUDFLARE_\w+ != ''/g, "")).not.toContain(secret);
  });
});

test("the deploy is skipped with a notice without the secrets, and verification follows it", () => {
  const { steps } = job();
  const guard = steps.findIndex((step) => step.env?.HAS_CLOUDFLARE_API_TOKEN !== undefined && step.env?.HAS_CLOUDFLARE_ACCOUNT_ID !== undefined);
  const deploy = indexOf((step) => step.run?.includes("pages deploy dist-shell --project-name ovis-app --branch main") === true);
  const verify = indexOf((step) => step.env?.SHELL_BUILD_URL !== undefined);
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(deploy).toBeGreaterThan(guard);
  expect(verify).toBeGreaterThan(deploy);
  const guardStep = steps[guard]!;
  expect(guardStep.env?.HAS_CLOUDFLARE_API_TOKEN).toBe("${{ secrets.CLOUDFLARE_API_TOKEN != '' }}");
  expect(guardStep.env?.HAS_CLOUDFLARE_ACCOUNT_ID).toBe("${{ secrets.CLOUDFLARE_ACCOUNT_ID != '' }}");
  expect(guardStep.run).toContain("::notice");
  expect(guardStep.run).toContain("ready=false");
  const ready = `steps.${guardStep.id}.outputs.ready == 'true'`;
  expect(steps[deploy]!.if).toBe(ready);
  expect(steps[verify]!.if).toBe(ready);
  expect(steps[deploy]!.env?.CLOUDFLARE_API_TOKEN).toBe("${{ secrets.CLOUDFLARE_API_TOKEN }}");
  expect(steps[deploy]!.env?.CLOUDFLARE_ACCOUNT_ID).toBe("${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
  expect(steps[verify]!.env?.SHELL_BUILD_URL).toBe("https://app.ovis.sh/build.json");
  expect(steps[verify]!.env?.EXPECTED_REVISION).toBe("${{ github.sha }}");
  expect(steps[verify]!.run).toContain("--max-time");
});

test("dist-shell.tar.gz and its SHA-256 are attached to the release from the artifact the deploy job packed", () => {
  const { steps } = job();
  expect(steps.some((step) => step.run?.includes("gh release upload") === true)).toBe(false);
  const pack = indexOf((step) => step.name === "Pack the shell");
  expect(steps[pack]!.run).toContain("sha256sum dist-shell.tar.gz");
  const upload = indexOf((step) => step.uses?.startsWith("actions/upload-artifact@") === true);
  expect(upload).toBe(pack + 1);
  expect(upload).toBeLessThan(indexOf((step) => step.env?.CLOUDFLARE_API_TOKEN !== undefined));
  expect(steps[upload]!.with?.["if-no-files-found"]).toBe("error");
  const attachSteps = attachJob().steps;
  const download = attachSteps.findIndex((step) => step.uses?.startsWith("actions/download-artifact@") === true);
  const attach = attachSteps.findIndex((step) => step.run?.includes("gh release upload") === true);
  expect(attachSteps[download]!.with?.name).toBe(steps[upload]!.with?.name);
  expect(attach).toBeGreaterThan(download);
  expect(attachSteps[attach]!.if).toBeUndefined();
  expect(attachSteps[attach]!.run).toContain("dist-shell.tar.gz");
  expect(attachSteps[attach]!.run).toContain("dist-shell.tar.gz.sha256");
  expect(attachSteps[attach]!.env?.GH_TOKEN).toBe("${{ github.token }}");
});

/** Runs the verify step's script through `bash -e` against a local server that answers each request with the next status and `body`. */
async function runVerifyStep(statuses: number[], body: string): Promise<{ code: number; output: string; requests: number }> {
  const step = job().steps.find((candidate) => candidate.env?.SHELL_BUILD_URL !== undefined)!;
  const expected = "a".repeat(40);
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      const status = statuses[Math.min(requests++, statuses.length - 1)]!;
      return status === 302
        ? new Response(null, { status, headers: { location: "/moved" } })
        : new Response(body, { status });
    },
  });
  const runner = await Bun.$`mktemp -d`.text();
  try {
    const script = step.run!.replace("sleep 5", "sleep 0");
    const child = Bun.spawn(["bash", "-e", "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, RUNNER_TEMP: runner.trim(), SHELL_BUILD_URL: `http://127.0.0.1:${server.port}/build.json`, EXPECTED_REVISION: expected },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, output: stdout + stderr, requests };
  } finally {
    await server.stop(true);
    await Bun.$`rm -rf ${runner.trim()}`.quiet();
  }
}

const REVISION = "a".repeat(40);
const revisionBody = (revision: string): string => `${JSON.stringify({ revision })}\n`;

test("verification passes on a 200 that names the tag's revision", async () => {
  expect((await runVerifyStep([200], revisionBody(REVISION))).code).toBe(0);
}, 30_000);

test("verification retries a 503 and a 302 until a 2xx", async () => {
  const result = await runVerifyStep([503, 302, 201], revisionBody(REVISION));
  expect(result.code).toBe(0);
  expect(result.requests).toBe(3);
}, 30_000);

test("verification fails on a 302 after bounded retries and says the code", async () => {
  const result = await runVerifyStep([302], revisionBody(REVISION));
  expect(result.code).not.toBe(0);
  expect(result.requests).toBe(12);
  expect(result.output).toContain("HTTP 302");
}, 30_000);

test("verification fails on a 200 that serves another revision", async () => {
  const result = await runVerifyStep([200], revisionBody("b".repeat(40)));
  expect(result.code).not.toBe(0);
  expect(result.requests).toBe(12);
  expect(result.output).toContain("did not serve revision");
}, 30_000);

test("verification fails when only a nested revision matches the tag's", async () => {
  const result = await runVerifyStep([200], JSON.stringify({ revision: "b".repeat(40), metadata: { revision: REVISION } }));
  expect(result.code).not.toBe(0);
  expect(result.requests).toBe(12);
  expect(result.output).toContain("did not serve revision");
}, 30_000);

test("verification fails on a body that is not JSON, even if it contains the revision", async () => {
  const result = await runVerifyStep([200], `<html>revision ${REVISION}</html>`);
  expect(result.code).not.toBe(0);
  expect(result.requests).toBe(12);
}, 30_000);

test("verification fails when the top-level revision is not a string", async () => {
  const result = await runVerifyStep([200], JSON.stringify({ revision: [REVISION] }));
  expect(result.code).not.toBe(0);
}, 30_000);
