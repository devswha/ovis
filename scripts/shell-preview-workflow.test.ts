import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface Step { name?: string; id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string> }
interface Job { needs?: string | string[]; if?: string; env?: Record<string, string>; "runs-on"?: unknown; environment?: string | { name: string; url?: string }; permissions?: Record<string, string>; "timeout-minutes"?: number; steps: Step[] }
interface Workflow { on: Record<string, unknown>; env?: Record<string, string>; permissions?: Record<string, string>; jobs: Record<string, Job> }

const parse = (path: string): Workflow => Bun.YAML.parse(readFileSync(path, "utf8")) as Workflow;
/** The preview workflow at SHELL_PREVIEW_WORKFLOW (a mutated copy) or the committed one. */
const preview = (): Workflow => parse(process.env.SHELL_PREVIEW_WORKFLOW ?? new URL("../.github/workflows/shell-preview.yml", import.meta.url).pathname);
const job = (): Job => preview().jobs["shell-preview"]!;
const step = (predicate: (step: Step) => boolean): Step => job().steps.find(predicate)!;
const deployStep = (): Step => step((candidate) => candidate.run?.includes("pages deploy dist-shell") === true);
const deployIndex = (): number => job().steps.findIndex((candidate) => candidate.run?.includes("pages deploy dist-shell") === true);

/** `--flag value` of a wrangler command line. */
const flag = (command: string, name: string): string | undefined => command.match(new RegExp(`--${name} (\\S+)`))?.[1];
/** The production deploy in release.yml: the branch that is app.ovis.sh, the project and the pinned wrangler. */
const production = (): { branch: string; project: string; wrangler: string } => {
  const run = parse(new URL("../.github/workflows/release.yml", import.meta.url).pathname).jobs["shell-deploy"]!.steps
    .find((candidate) => candidate.run?.includes("pages deploy dist-shell") === true)!.run!;
  return { branch: flag(run, "branch")!, project: flag(run, "project-name")!, wrangler: run.match(/wrangler@(\S+)/)![1]! };
};

test("it runs only by hand, from main of devswha/ovis", () => {
  expect(Object.keys(preview().on)).toEqual(["workflow_dispatch"]);
  expect(job().if).toBe("github.repository == 'devswha/ovis' && github.ref == 'refs/heads/main'");
  expect(Object.keys(preview().jobs)).toEqual(["shell-preview"]);
});

test("it waits in production on a GitHub-hosted runner, reading only, with pinned actions", () => {
  const environment = job().environment;
  expect(typeof environment === "string" ? environment : environment?.name).toBe("production");
  expect(job()["runs-on"]).toBe("ubuntu-24.04");
  expect(preview().permissions).toEqual({ contents: "read" });
  expect(job().permissions).toEqual({ contents: "read" });
  expect(job()["timeout-minutes"]).toBeGreaterThan(0);
  for (const candidate of job().steps) if (candidate.uses && !candidate.uses.startsWith("./")) expect(candidate.uses).toMatch(/@[0-9a-f]{40}$/);
  expect(step((candidate) => candidate.uses?.startsWith("actions/checkout@") === true).with?.ref).toBe("${{ github.sha }}");
});

test("it deploys to the fixed preview branch of the production project, never to its production branch", () => {
  const run = deployStep().run!;
  const { branch, project, wrangler } = production();
  expect(branch).toBe("main");
  expect(run).toBe(`bunx wrangler@${wrangler} pages deploy dist-shell --project-name ${project} --branch preview`);
  expect(wrangler).toBe("4.156.0");
  const previewBranch = flag(run, "branch")!;
  expect(previewBranch).not.toBe("main");
  expect(previewBranch).not.toBe(branch);
  expect(run.match(/--branch/g)).toHaveLength(1);
  const url = `https://${previewBranch}.${project}.pages.dev`;
  expect(url).toBe("https://preview.ovis-app.pages.dev");
  const environment = job().environment;
  expect(typeof environment === "string" ? undefined : environment?.url).toBe(`${url}/`);
  expect(step((candidate) => candidate.env?.SHELL_BUILD_URL !== undefined).env?.SHELL_BUILD_URL).toBe(`${url}/build.json`);
});

test("only the deploy step receives the Cloudflare secrets; the check before it sees only whether they are set", () => {
  const secret = "secrets.CLOUDFLARE_";
  expect(JSON.stringify(preview().env ?? {})).not.toContain(secret);
  expect(JSON.stringify(job().env ?? {})).not.toContain(secret);
  const deploy = deployIndex();
  expect(deploy).toBeGreaterThanOrEqual(0);
  job().steps.forEach((candidate, index) => {
    if (index !== deploy) expect(JSON.stringify(candidate).replace(/secrets\.CLOUDFLARE_\w+ != ''/g, "")).not.toContain(secret);
  });
  expect(deployStep().env).toEqual({ CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}", CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}" });
});

test("build, the built shell, the secrets, the deploy and its verification run in that order, unconditionally", () => {
  const { steps } = job();
  const at = (predicate: (step: Step) => boolean): number => steps.findIndex(predicate);
  const order = [
    at((candidate) => candidate.run === "bun run build:shell"),
    at((candidate) => candidate.name === "Require the built shell"),
    at((candidate) => candidate.env?.HAS_CLOUDFLARE_API_TOKEN !== undefined),
    deployIndex(),
    at((candidate) => candidate.env?.SHELL_BUILD_URL !== undefined),
  ];
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(order[0]).toBeGreaterThanOrEqual(0);
  expect(new Set(order).size).toBe(order.length);
  for (const candidate of steps) expect(candidate.if).toBeUndefined();
  expect(steps[order[4]!]!.env?.EXPECTED_REVISION).toBe("${{ github.sha }}");
});

/** Runs a step's script through `bash -e` in `cwd` with `env`; `sleep 5` becomes `sleep 0`. */
async function runStep(found: Step, cwd: string, env: Record<string, string>): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(["bash", "-e", "-c", found.run!.replace("sleep 5", "sleep 0")], {
    cwd, stdout: "pipe", stderr: "pipe",
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, RUNNER_TEMP: cwd, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: stdout + stderr };
}

const withDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "shell-preview-"));
  try { await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("a build without index.html or build.json fails before the deploy", async () => {
  const required = step((candidate) => candidate.name === "Require the built shell");
  await withDir(async (dir) => {
    mkdirSync(join(dir, "dist-shell"));
    writeFileSync(join(dir, "dist-shell", "index.html"), "<!doctype html>");
    const missing = await runStep(required, dir, {});
    expect(missing.code).not.toBe(0);
    expect(missing.output).toContain("dist-shell/build.json");
    writeFileSync(join(dir, "dist-shell", "build.json"), "{}\n");
    expect((await runStep(required, dir, {})).code).toBe(0);
  });
});

test("unset Cloudflare secrets fail the run and are named", async () => {
  const check = step((candidate) => candidate.env?.HAS_CLOUDFLARE_API_TOKEN !== undefined);
  await withDir(async (dir) => {
    const unset = await runStep(check, dir, { HAS_CLOUDFLARE_API_TOKEN: "true", HAS_CLOUDFLARE_ACCOUNT_ID: "false" });
    expect(unset.code).not.toBe(0);
    expect(unset.output).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect((await runStep(check, dir, { HAS_CLOUDFLARE_API_TOKEN: "true", HAS_CLOUDFLARE_ACCOUNT_ID: "true" })).code).toBe(0);
  });
});

/** The verify step against a local server answering every request with `status` and `body`. */
async function verify(status: number, body: string): Promise<{ code: number; requests: number; output: string }> {
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return new Response(body, { status }); } });
  try {
    let result = { code: -1, output: "" };
    await withDir(async (dir) => {
      result = await runStep(step((candidate) => candidate.env?.SHELL_BUILD_URL !== undefined), dir, {
        SHELL_BUILD_URL: `http://127.0.0.1:${server.port}/build.json`, EXPECTED_REVISION: "a".repeat(40),
      });
    });
    return { ...result, requests };
  } finally {
    await server.stop(true);
  }
}

test("verification passes once the preview serves this revision", async () => {
  const result = await verify(200, `${JSON.stringify({ revision: "a".repeat(40) })}\n`);
  expect(result.code).toBe(0);
  expect(result.requests).toBe(1);
}, 30_000);

test("verification fails after bounded retries while the preview serves another revision", async () => {
  const result = await verify(200, `${JSON.stringify({ revision: "b".repeat(40) })}\n`);
  expect(result.code).not.toBe(0);
  expect(result.requests).toBe(12);
  expect(result.output).toContain("did not serve revision");
}, 30_000);
