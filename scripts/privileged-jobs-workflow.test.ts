import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_HOSTED_LABELS, parseWorkflow, root, topLevelTerms, type Job, type Step } from "./shell-workflow-rules.ts";

// Anyone who holds a runner registration token can register a self-hosted runner under any label; it then takes the
// jobs that ask for that label, with the run's runtime token, which lets a job write any artifact of its run and any
// Actions cache its ref's later runs restore. This test enforces two rules on the workflow files:
// - a job that holds a write permission (id-token included), an environment or a secret (its own, its workflow env's,
//   `secrets[...]`, `toJSON(secrets)`) names one of GITHUB_HOSTED_LABELS literally, or a matrix of them;
// - in a run that contains actions/deploy-pages (which takes the run's artifact by name), every job of the workflow and of
//   every workflow called in that run names a listed label literally (or a matrix of them), or uses exactly
//   `${{ inputs.hosted_only && '<listed label>' || ... }}` in a workflow whose call passes `hosted_only: true` literally;
//   every cache-capable step is off in exactly a reviewed form (setup-ci `cache: none`, or
//   `${{ inputs.hosted_only && 'none' || ... }}` under such a call; actions/cache and actions/cache/restore only with
//   `!inputs.hosted_only` as a top-level `&&` term of their `if`, under such a call); every action is one of
//   REVIEWED_ACTIONS at its exact reference. It fails closed on any other form, whatever that form would evaluate to.
// It reads runner labels, actions and their inputs only: it does not inspect shell commands or scripts for cache access.
// That GitHub gives a job asking only for a hosted label to its own runners, even when a self-registered runner carries
// that label, was observed by a trial on 2026-11-17 (14 of 14 jobs); it is not documented by GitHub
// (scripts/self-hosted-runner/README.md, "Security model").

/** A secret a job's steps or expressions read, from the job or its workflow's env; the automatic GITHUB_TOKEN is counted by the permissions instead. */
const SECRET = /(?<![\w.-])secrets\s*(?:\.\s*(?!GITHUB_TOKEN\b)\w+|\[)|toJSON\(\s*secrets\s*\)/i;
/** The actions a job of a Pages run may use, each at the exact reference reviewed. */
const REVIEWED_ACTIONS = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "./.github/actions/setup-ci",
  "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
  "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
  "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9",
  "actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346",
];
/** The actions setup-ci's own steps may use, each at the exact reference reviewed. */
const SETUP_CI_ACTIONS = [
  "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
  "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
  "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
];
const LABEL_FORM = /^\$\{\{ inputs\.hosted_only && '([^']+)' \|\| .+ \}\}$/s;
const NO_CACHE_FORM = /^\$\{\{ inputs\.hosted_only && 'none' \|\| .+ \}\}$/s;

type Permissions = Record<string, string> | "read-all" | "write-all";
type Matrix = Record<string, unknown> & { include?: Record<string, unknown>[] };
type AnyStep = Omit<Step, "with"> & { with?: Record<string, unknown> };
type AnyJob = Omit<Job, "permissions" | "steps"> & { permissions?: Permissions; strategy?: { matrix?: Matrix | string }; secrets?: "inherit" | Record<string, string>; with?: Record<string, unknown>; steps?: AnyStep[] };
type AnyWorkflow = { name?: string; on: unknown; env?: Record<string, string>; permissions?: Permissions; jobs: Record<string, AnyJob> };
type Workflows = Record<string, AnyWorkflow>;

const events = (on: unknown): Record<string, { inputs?: Record<string, { type?: string; default?: unknown }> } | null> =>
  (typeof on === "string" ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map((event: string) => [event, null])) : (on as Record<string, null>));
const calledFile = (job: AnyJob): string | undefined => /^\.\/\.github\/workflows\/(.+\.yml)$/.exec(job.uses ?? "")?.[1];
const action = (uses: string): string => uses.replace(/@.*/, "");
const writes = (permissions: Permissions): string[] =>
  permissions === "write-all" ? ["write-all"] : permissions === "read-all" ? [] : Object.entries(permissions).filter(([, access]) => access === "write").map(([scope]) => `${scope}: write`);

/**
 * The write scopes `job`'s token can hold: its own permissions, else its workflow's. With neither, the repository's
 * default for a run of the workflow itself (a setting outside the repository, so counted as write), and each caller's
 * for a call (a called workflow's token is capped by its caller's, and inherits it when the workflow sets none).
 */
function writeScopes(workflows: Workflows, file: string, job: AnyJob): string[] {
  const workflow = workflows[file]!;
  const own = job.permissions ?? workflow.permissions;
  if (own !== undefined) return writes(own);
  const scopes = new Set<string>();
  if (Object.keys(events(workflow.on)).some((event) => event !== "workflow_call")) scopes.add("default permissions (counted as write)");
  for (const [callerFile, caller] of Object.entries(workflows)) {
    for (const callerJob of Object.values(caller.jobs).filter((candidate) => calledFile(candidate) === file)) {
      for (const scope of writeScopes(workflows, callerFile, callerJob)) scopes.add(scope);
    }
  }
  return [...scopes];
}

/** What makes `job` privileged: write scopes, an environment, a secret (its own, its workflow env's, or a caller's `secrets: inherit` it reads). */
function privileges(workflows: Workflows, file: string, job: AnyJob): string[] {
  const reasons = writeScopes(workflows, file, job);
  if (job.environment !== undefined) reasons.push("environment");
  const secret = SECRET.exec(JSON.stringify([workflows[file]!.env ?? {}, job]));
  if (secret) reasons.push(secret[0]);
  return reasons;
}

/** Whether `job` names a hosted label literally, or a matrix axis whose every value is one. */
function hostedLiteral(job: AnyJob): boolean {
  const runsOn = job["runs-on"];
  if (typeof runsOn !== "string") return false;
  if (GITHUB_HOSTED_LABELS.includes(runsOn)) return true;
  const axis = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(runsOn)?.[1];
  const matrix = job.strategy?.matrix;
  if (axis === undefined || typeof matrix !== "object") return false;
  const base = matrix[axis];
  if (base !== undefined && !Array.isArray(base)) return false;
  const include = matrix.include ?? [];
  // an include entry without the axis adds a combination of its own when the matrix has no such axis to merge into
  if (base === undefined && include.some((entry) => !(axis in entry))) return false;
  const values = [...((base as unknown[] | undefined) ?? []), ...include.filter((entry) => axis in entry).map((entry) => entry[axis])];
  return values.length > 0 && values.every((value) => typeof value === "string" && GITHUB_HOSTED_LABELS.includes(value));
}

/** Each privileged job of `workflows` that can reach a runner GitHub does not host. */
function privilegeProblems(workflows: Workflows): string[] {
  return Object.entries(workflows).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs)
      .filter(([, job]) => job["runs-on"] !== undefined && !hostedLiteral(job))
      .map(([id, job]) => ({ id, job, reasons: privileges(workflows, file, job) }))
      .filter(({ reasons }) => reasons.length > 0)
      .map(({ id, job, reasons }) => `${file} ${id}: runs-on ${JSON.stringify(job["runs-on"])} with ${reasons.join(", ")}`),
  );
}

/** The workflows whose own runs contain `file`'s jobs: itself when an event other than a call starts it, and its callers' roots. */
function runRoots(workflows: Workflows, file: string): string[] {
  const roots = Object.keys(events(workflows[file]!.on)).some((event) => event !== "workflow_call") ? [file] : [];
  for (const [callerFile, caller] of Object.entries(workflows)) {
    if (Object.values(caller.jobs).some((job) => calledFile(job) === file)) roots.push(...runRoots(workflows, callerFile));
  }
  return [...new Set(roots)];
}

/** Why the run that `root` starts is not GitHub-hosted and cacheless in a reviewed form. */
function runProblems(workflows: Workflows, root: string): string[] {
  const problems = new Set<string>();
  const visit = (file: string, hostedOnly: boolean): void => {
    for (const [id, job] of Object.entries(workflows[file]!.jobs)) {
      const where = `${root}: ${file} ${id}`;
      const callee = calledFile(job);
      if (callee !== undefined) {
        visit(callee, job.with?.["hosted_only"] === true);
        continue;
      }
      const runsOn = job["runs-on"];
      const prefixed = typeof runsOn === "string" ? LABEL_FORM.exec(runsOn) : null;
      if (!hostedLiteral(job) && !(hostedOnly && prefixed !== null && GITHUB_HOSTED_LABELS.includes(prefixed[1]!))) {
        problems.add(`${where}: runs-on ${JSON.stringify(runsOn)} is neither a listed hosted label nor the hosted_only form under a call that passes hosted_only: true`);
      }
      for (const step of job.steps ?? []) {
        if (step.uses === undefined) continue;
        if (!REVIEWED_ACTIONS.includes(step.uses)) problems.add(`${where}: uses ${step.uses}, which is not a reviewed action reference`);
        if (action(step.uses) === "./.github/actions/setup-ci") {
          const cache = step.with?.["cache"];
          if (!(cache === "none" || (hostedOnly && typeof cache === "string" && NO_CACHE_FORM.test(cache)))) {
            problems.add(`${where}: setup-ci cache ${JSON.stringify(cache ?? "save (default)")} is neither none nor the hosted_only form under a call that passes hosted_only: true`);
          }
        } else if (action(step.uses).startsWith("actions/cache")) {
          if (!(hostedOnly && topLevelTerms(step.if ?? "").includes("!inputs.hosted_only"))) {
            problems.add(`${where}: ${action(step.uses)} if ${JSON.stringify(step.if ?? null)} has no top-level && !inputs.hosted_only term under a call that passes hosted_only: true`);
          }
        } else if (step.with?.["cache"] !== undefined) {
          problems.add(`${where}: ${action(step.uses)} has a cache input`);
        }
      }
    }
  };
  visit(root, false);
  return [...problems];
}

/** setup-ci's cache steps that can run under `cache: none`: each needs `inputs.cache == 'save'` or `'restore'` as a top-level `&&` term. */
function setupCiCacheProblems(steps: AnyStep[]): string[] {
  return steps
    .filter((step) => step.uses !== undefined && action(step.uses).startsWith("actions/cache"))
    .filter((step) => !topLevelTerms(step.if ?? "").some((term) => term === "inputs.cache == 'save'" || term === "inputs.cache == 'restore'"))
    .map((step) => `setup-ci ${step.name ?? step.uses}: if ${JSON.stringify(step.if ?? null)} has no top-level && inputs.cache == 'save' or 'restore' term, so it can run under cache: none`);
}

/** The problems of every run that contains a job deploying Pages. */
function pagesProblems(workflows: Workflows): string[] {
  return Object.entries(workflows).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs)
      .filter(([, job]) => (job.steps ?? []).some((step) => step.uses !== undefined && action(step.uses) === "actions/deploy-pages"))
      .flatMap(() => runRoots(workflows, file).flatMap((runRoot) => runProblems(workflows, runRoot))),
  );
}

const dir = join(root, ".github/workflows");
const repository: Workflows = Object.fromEntries(
  readdirSync(dir)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => [name, parseWorkflow(join(dir, name)) as unknown as AnyWorkflow]),
);
const setupCi = Bun.YAML.parse(readFileSync(join(root, ".github/actions/setup-ci/action.yml"), "utf8")) as { inputs: { cache: { default: string } }; runs: { steps: AnyStep[] } };

const LIGHT = "${{ github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-24.04' || fromJSON(github.ref == 'refs/heads/main' && vars.CI_MAIN_SELF_HOSTED_LABELS || vars.CI_LIGHT_LABELS || vars.CI_SELF_HOSTED_LABELS || '[\"self-hosted\",\"self-hosted-ovis\"]') }}";
const VARIABLE = "${{ vars.CI_SELF_HOSTED_LABELS && fromJSON(vars.CI_SELF_HOSTED_LABELS) || 'ubuntu-24.04' }}";
const HOSTED_ONLY = "${{ inputs.hosted_only && 'ubuntu-24.04' || fromJSON(vars.CI_SELF_HOSTED_LABELS) }}";
const DEPLOY: AnyJob = { "runs-on": "ubuntu-24.04", permissions: { pages: "write", "id-token": "write" }, environment: "github-pages", steps: [{ uses: "actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346" }] };
const one = (job: AnyJob, permissions: Permissions | null = { contents: "read" }, env?: Record<string, string>): Workflows => ({
  "x.yml": { on: { push: {} }, ...(permissions && { permissions }), ...(env && { env }), jobs: { job } },
});
const called = (callerJob: AnyJob, calledJob: AnyJob): Workflows => ({
  "caller.yml": { on: { push: {} }, permissions: { contents: "read" }, jobs: { call: { uses: "./.github/workflows/called.yml", ...callerJob } } },
  "called.yml": { on: { workflow_call: {} }, jobs: { job: calledJob } },
});
/** A Pages run: deploy, a sibling job, and a call of a workflow with a hosted_only input. */
const pages = (sibling: AnyJob, call: Record<string, unknown> | undefined, calledJob: AnyJob): Workflows => ({
  "site.yml": { on: { workflow_dispatch: {} }, permissions: { contents: "read" }, jobs: { validate: { uses: "./.github/workflows/checks.yml", ...(call && { with: call }) }, sibling, deploy: DEPLOY } },
  "checks.yml": { on: { push: {}, workflow_call: { inputs: { hosted_only: { type: "boolean", default: false } } } }, permissions: { contents: "read" }, jobs: { check: calledJob } },
});
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const CACHE = "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
const HOSTED_JOB: AnyJob = { "runs-on": "ubuntu-24.04", steps: [{ uses: CHECKOUT }] };
const cacheIf = (condition: string): AnyJob => ({ "runs-on": HOSTED_ONLY, steps: [{ uses: CACHE, if: condition, with: { path: "x", key: "k" } }] });

describe("jobs that hold a write permission, an environment or a secret", () => {
  test("every one in .github/workflows names a GitHub-hosted label literally", () => {
    expect(privilegeProblems(repository)).toEqual([]);
  });

  test("the Pages deploy, the release's publish job and the Mac app's gate count as privileged", () => {
    expect(privileges(repository, "pages.yml", repository["pages.yml"]!.jobs.deploy!)).toEqual(["pages: write", "id-token: write", "environment"]);
    expect(privileges(repository, "release.yml", repository["release.yml"]!.jobs.publish!)).toEqual(["contents: write"]);
    // Release hands the Mac app workflow every secret; its gate reads whether the signing ones are set
    expect(repository["release.yml"]!.jobs["mac-dmg"]!).toMatchObject({ secrets: "inherit" });
    const gate = privileges(repository, "mac-dmg.yml", repository["mac-dmg.yml"]!.jobs.gate!);
    expect(gate).toHaveLength(1);
    expect(gate[0]).toMatch(/^secrets\.MAC_/);
  });

  const cases: [string, Workflows, number][] = [
    ["refuses the light runner expression for a job that deploys Pages", one({ "runs-on": LIGHT, permissions: { contents: "read", pages: "write", "id-token": "write" } }), 1],
    ["refuses a runner variable even with a hosted fallback for a write token", one({ "runs-on": VARIABLE, permissions: { contents: "write" } }), 1],
    ["refuses id-token: write alone", one({ "runs-on": VARIABLE, permissions: { "id-token": "write" } }), 1],
    ["refuses write-all", one({ "runs-on": VARIABLE, permissions: "write-all" }), 1],
    ["refuses self-hosted labels for a job with an environment", one({ "runs-on": ["self-hosted", "self-hosted-ovis"], environment: "production" }), 1],
    ["refuses an input for a job with a secret", one({ "runs-on": "${{ inputs.runner }}", steps: [{ run: "x", env: { KEY: "${{ secrets.KEY }}" } }] }), 1],
    ["refuses a job output for a job that only checks a secret is set", one({ "runs-on": "${{ fromJSON(needs.route.outputs.labels) }}", env: { HAS: "${{ secrets.KEY != '' }}" } }), 1],
    ["refuses a secret its workflow's env hands every job", one({ "runs-on": LIGHT }, { contents: "read" }, { KEY: "${{ secrets.KEY }}" }), 1],
    ["refuses a secret read by index", one({ "runs-on": LIGHT, env: { KEY: "${{ secrets['KEY'] }}" } }), 1],
    ["refuses every secret at once", one({ "runs-on": LIGHT, env: { ALL: "${{ toJSON(secrets) }}" } }), 1],
    ["refuses a hosted label inside an expression", one({ "runs-on": "${{ 'ubuntu-24.04' }}", permissions: { contents: "write" } }), 1],
    ["refuses a lookalike label", one({ "runs-on": "ubuntu-self-hosted", permissions: { contents: "write" } }), 1],
    ["refuses a label of a hosted form that is not on the list", one({ "runs-on": "ubuntu-99.99", permissions: { contents: "write" } }), 1],
    ["refuses a matrix one of whose runners is a variable", one({ "runs-on": "${{ matrix.os }}", permissions: { contents: "write" }, strategy: { matrix: { include: [{ os: "ubuntu-24.04" }, { os: "${{ vars.LABELS }}" }] } } }), 1],
    ["refuses a matrix one of whose runners is not on the list", one({ "runs-on": "${{ matrix.os }}", permissions: { contents: "write" }, strategy: { matrix: { os: ["ubuntu-24.04", "windows-9999"] } } }), 1],
    ["refuses a matrix whose axis is an expression", one({ "runs-on": "${{ matrix.os }}", permissions: { contents: "write" }, strategy: { matrix: { os: "${{ fromJSON(vars.OSES) }}" } } }), 1],
    ["refuses a job with no permissions in a workflow with none: the repository default counts as write", one({ "runs-on": LIGHT }, null), 1],
    ["refuses a job that inherits its workflow's write token", one({ "runs-on": LIGHT }, { contents: "write" }), 1],
    ["refuses a called job that inherits its caller's write token", called({ permissions: { contents: "write" } }, { "runs-on": VARIABLE }), 1],
    ["refuses a called job that reads a secret its caller passes with secrets: inherit", called({ secrets: "inherit" }, { "runs-on": VARIABLE, permissions: { contents: "read" }, env: { KEY: "${{ secrets.KEY }}" } }), 1],
    ["refuses secrets.GITHUB_TOKEN with a write permission", one({ "runs-on": LIGHT, permissions: { contents: "write" }, env: { TOKEN: "${{ secrets.GITHUB_TOKEN }}" } }), 1],
    ["allows hosted labels written literally", one({ "runs-on": "ubuntu-24.04-arm", permissions: { contents: "write", "id-token": "write" }, environment: "production", env: { KEY: "${{ secrets.KEY }}" } }), 0],
    ["allows a matrix of hosted labels only", one({ "runs-on": "${{ matrix.os }}", env: { KEY: "${{ secrets.KEY }}" }, strategy: { matrix: { os: ["windows-2025"], include: [{ os: "macos-15-intel" }, { os: "ubuntu-24.04" }] } } }), 0],
    ["allows any runner for a read-only job without a secret", one({ "runs-on": LIGHT, permissions: { contents: "read", actions: "read" }, env: { TOKEN: "${{ secrets.GITHUB_TOKEN }}", OUT: "${{ steps.secrets.outputs.x }}" } }), 0],
    ["lets a job's read-only permissions override its workflow's write token", one({ "runs-on": LIGHT, permissions: { contents: "read" } }, { contents: "write" }), 0],
    ["allows any runner for a called job whose caller grants only reads", called({ permissions: { contents: "read" } }, { "runs-on": VARIABLE }), 0],
  ];
  for (const [name, workflows, count] of cases) {
    test(name, () => {
      expect(privilegeProblems(workflows)).toHaveLength(count);
    });
  }
});

describe("a run that deploys Pages is GitHub-hosted and cacheless as a whole", () => {
  test("pages.yml's runs, with the ci.yml its validation calls", () => {
    expect(pagesProblems(repository)).toEqual([]);
    expect(runRoots(repository, "pages.yml")).toEqual(["pages.yml"]);
    expect(repository["pages.yml"]!.jobs.validate).toMatchObject({ uses: "./.github/workflows/ci.yml", with: { hosted_only: true } });
  });

  test("setup-ci's `cache: none` restores no cache: its cache steps need another mode, setup-bun is told not to, and it uses only reviewed actions", () => {
    const steps = setupCi.runs.steps;
    expect(setupCi.inputs.cache.default).not.toBe("none");
    const caches = steps.filter((step) => step.uses?.startsWith("actions/cache"));
    expect(caches.length).toBeGreaterThan(0);
    expect(setupCiCacheProblems(steps)).toEqual([]);
    const bun = steps.filter((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
    expect(bun.length).toBeGreaterThan(0);
    for (const step of bun) expect(step.with?.["no-cache"]).toBe("${{ inputs.cache == 'none' }}");
    for (const step of steps.filter((candidate) => candidate.uses !== undefined)) {
      expect(SETUP_CI_ACTIONS).toContain(step.uses!);
      if (action(step.uses!) === "actions/setup-node") expect(step.with?.["cache"]).toBeUndefined();
    }
  });

  test("a setup-ci cache step with its mode anywhere but a top-level && term can run under cache: none", () => {
    const step = (condition?: string): AnyStep => ({ name: "Cache Bun dependencies", uses: CACHE, ...(condition !== undefined && { if: condition }) });
    const message = (condition: string | null): string => `setup-ci Cache Bun dependencies: if ${JSON.stringify(condition)} has no top-level && inputs.cache == 'save' or 'restore' term, so it can run under cache: none`;
    expect(setupCiCacheProblems([step("runner.environment != 'self-hosted' && inputs.cache == 'save'"), step("inputs.cache == 'restore'")])).toEqual([]);
    for (const condition of [
      "always() || runner.environment != 'self-hosted' && inputs.cache == 'save'",
      "runner.environment != 'self-hosted' && (always() || inputs.cache == 'save')",
      "runner.environment != 'self-hosted'",
    ]) {
      expect(setupCiCacheProblems([step(condition)])).toEqual([message(condition)]);
    }
    expect(setupCiCacheProblems([step()])).toEqual([message(null)]);
  });

  test("a condition's top-level && terms: none when its top level is an ||", () => {
    expect(topLevelTerms("${{ needs.a.outputs.b != 'true' && !inputs.hosted_only }}")).toEqual(["needs.a.outputs.b != 'true'", "!inputs.hosted_only"]);
    expect(topLevelTerms("always() && (failure() || !inputs.hosted_only)")).toEqual(["always()", "(failure() || !inputs.hosted_only)"]);
    expect(topLevelTerms("!inputs.hosted_only || always()")).toEqual([]);
    expect(topLevelTerms("contains('a && b', x) && !inputs.hosted_only")).toEqual(["contains('a && b', x)", "!inputs.hosted_only"]);
  });

  const SIBLING = "site.yml: site.yml sibling";
  const CHECK = "site.yml: checks.yml check";
  const RUNS_ON = "is neither a listed hosted label nor the hosted_only form under a call that passes hosted_only: true";
  const NO_TERM = "has no top-level && !inputs.hosted_only term under a call that passes hosted_only: true";
  const cases: [string, Workflows, string[]][] = [
    ["allows a run whose every job is hosted and cacheless in a reviewed form", pages(HOSTED_JOB, { hosted_only: true }, { "runs-on": HOSTED_ONLY, steps: [{ uses: "./.github/actions/setup-ci", with: { cache: "${{ inputs.hosted_only && 'none' || 'save' }}" } }, { uses: CACHE, if: "always() && !inputs.hosted_only" }] }), []],
    ["refuses a sibling job on the light runner expression", pages({ ...HOSTED_JOB, "runs-on": LIGHT }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: runs-on ${JSON.stringify(LIGHT)} ${RUNS_ON}`]],
    ["refuses a runner that is hosted in the test's context only (the event of a workflow_run)", pages({ ...HOSTED_JOB, "runs-on": "${{ github.event.workflow_run.event == 'push' && fromJSON(vars.X) || 'ubuntu-24.04' }}" }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: runs-on "\${{ github.event.workflow_run.event == 'push' && fromJSON(vars.X) || 'ubuntu-24.04' }}" ${RUNS_ON}`]],
    ["refuses a runner that is hosted only while a variable is set", pages({ ...HOSTED_JOB, "runs-on": "${{ vars.X && 'ubuntu-24.04' || fromJSON('[\"self-hosted\"]') }}" }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: runs-on "\${{ vars.X && 'ubuntu-24.04' || fromJSON('[\\"self-hosted\\"]') }}" ${RUNS_ON}`]],
    ["refuses a label of a hosted form that is not on the list", pages({ ...HOSTED_JOB, "runs-on": "ubuntu-99.99" }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: runs-on "ubuntu-99.99" ${RUNS_ON}`]],
    ["refuses the hosted_only form outside a call that passes it", pages({ ...HOSTED_JOB, "runs-on": HOSTED_ONLY }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: runs-on ${JSON.stringify(HOSTED_ONLY)} ${RUNS_ON}`]],
    ["refuses a called job whose call does not pass hosted_only", pages(HOSTED_JOB, undefined, { "runs-on": HOSTED_ONLY }), [`${CHECK}: runs-on ${JSON.stringify(HOSTED_ONLY)} ${RUNS_ON}`]],
    ["refuses a called job whose call passes hosted_only as an expression", pages(HOSTED_JOB, { hosted_only: "${{ github.ref == 'refs/heads/main' }}" }, { "runs-on": HOSTED_ONLY }), [`${CHECK}: runs-on ${JSON.stringify(HOSTED_ONLY)} ${RUNS_ON}`]],
    ["refuses setup-ci's default cache", pages({ ...HOSTED_JOB, steps: [{ uses: "./.github/actions/setup-ci" }] }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: setup-ci cache "save (default)" is neither none nor the hosted_only form under a call that passes hosted_only: true`]],
    ["refuses setup-ci's cache taken from a variable", pages({ ...HOSTED_JOB, steps: [{ uses: "./.github/actions/setup-ci", with: { cache: "${{ vars.MODE }}" } }] }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: setup-ci cache "\${{ vars.MODE }}" is neither none nor the hosted_only form under a call that passes hosted_only: true`]],
    ["refuses a cache step with no condition", pages({ ...HOSTED_JOB, steps: [{ uses: CACHE, with: { path: "x", key: "k" } }] }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: actions/cache if null ${NO_TERM}`]],
    ["refuses a cache step that runs in every real workflow_run", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("github.event.workflow_run.conclusion == 'success'")), [`${CHECK}: actions/cache if "github.event.workflow_run.conclusion == 'success'" ${NO_TERM}`]],
    ["refuses a cache step gated on a variable", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("vars.CACHE_MODE == 'enabled'")), [`${CHECK}: actions/cache if "vars.CACHE_MODE == 'enabled'" ${NO_TERM}`]],
    ["refuses a cache step that runs after a failure", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("failure()")), [`${CHECK}: actions/cache if "failure()" ${NO_TERM}`]],
    ["refuses a cache step gated on a step's output", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("steps.x.outputs.y == 'true'")), [`${CHECK}: actions/cache if "steps.x.outputs.y == 'true'" ${NO_TERM}`]],
    ["refuses a cache step gated on an input the call never sets (GitHub reads it as true)", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("inputs.missing == false")), [`${CHECK}: actions/cache if "inputs.missing == false" ${NO_TERM}`]],
    ["refuses !inputs.hosted_only inside an ||", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("!inputs.hosted_only || always()")), [`${CHECK}: actions/cache if "!inputs.hosted_only || always()" ${NO_TERM}`]],
    ["refuses !inputs.hosted_only inside parentheses with an ||", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("(always() && !inputs.hosted_only) || failure()")), [`${CHECK}: actions/cache if "(always() && !inputs.hosted_only) || failure()" ${NO_TERM}`]],
    ["refuses a cache step gated on hosted_only outside a call that passes it", pages(HOSTED_JOB, undefined, { "runs-on": "ubuntu-24.04", steps: [{ uses: CACHE, if: "!inputs.hosted_only" }] }), [`${CHECK}: actions/cache if "!inputs.hosted_only" ${NO_TERM}`]],
    ["refuses a reviewed action at another reference", pages({ ...HOSTED_JOB, steps: [{ uses: "actions/checkout@v7" }] }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: uses actions/checkout@v7, which is not a reviewed action reference`]],
    ["refuses an action that is not reviewed", pages({ ...HOSTED_JOB, steps: [{ uses: "Swatinem/rust-cache@v2" }] }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: uses Swatinem/rust-cache@v2, which is not a reviewed action reference`]],
    ["refuses a cache input on an action", pages({ ...HOSTED_JOB, steps: [{ uses: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1", with: { cache: "npm" } }] }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: uses actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1, which is not a reviewed action reference`, `${SIBLING}: actions/setup-node has a cache input`]],
    ["refuses a run that calls the Pages workflow from a self-hosted one", {
      ...pages(HOSTED_JOB, { hosted_only: true }, HOSTED_JOB),
      "site.yml": { ...pages(HOSTED_JOB, { hosted_only: true }, HOSTED_JOB)["site.yml"]!, on: { workflow_call: {} } },
      "outer.yml": { on: { push: {} }, permissions: { contents: "read" }, jobs: { light: { "runs-on": LIGHT }, site: { uses: "./.github/workflows/site.yml" } } },
    }, [`outer.yml: outer.yml light: runs-on ${JSON.stringify(LIGHT)} ${RUNS_ON}`]],
  ];
  for (const [name, workflows, problems] of cases) {
    test(name, () => {
      expect(pagesProblems(workflows)).toEqual(problems);
    });
  }
});
