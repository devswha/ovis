import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
type SetupAction = {
  inputs: Record<string, { default: string }>;
  runs: { steps: Array<{ name?: string; uses?: string; if?: string; with?: Record<string, string>; env?: Record<string, string> }> };
};
const actionSource = readFileSync(join(root, ".github/actions/setup-ci/action.yml"), "utf8");
const action = Bun.YAML.parse(actionSource) as SetupAction;

// Steps are found by action repository, not by ref, so an urgent pin to a commit SHA keeps passing.
const usesAction = (repository: string) => (step: { uses?: string }) => step.uses?.startsWith(`${repository}@`) === true;

function expectHostedOnlySetup(setup: SetupAction) {
  for (const name of ["Cache Bun dependencies", "Restore Bun dependencies (read-only)"]) {
    expect(setup.runs.steps.find((step) => step.name === name)!.if).toStartWith("runner.environment != 'self-hosted' && ");
  }
  for (const repository of ["oven-sh/setup-bun", "actions/setup-node"]) {
    expect(setup.runs.steps.find(usesAction(repository))!.if).toContain("runner.environment != 'self-hosted'");
  }
  expect(setup.runs.steps.find((step) => step.name === "Install checksum-pinned herdr 0.9.3")!.if)
    .toContain("runner.environment != 'self-hosted'");
}

type UpdateEntry = Record<string, unknown> & {
  "package-ecosystem"?: string;
  directories?: string[];
  schedule?: { interval?: string };
  groups?: unknown;
  cooldown?: Record<string, unknown>;
};
const dependabot = Bun.YAML.parse(readFileSync(join(root, ".github/dependabot.yml"), "utf8")) as { updates: UpdateEntry[] };

/** Problems with an Actions update policy: one monthly grouped entry whose only age rule is a flat seven-day wait. */
function actionsPolicyProblems(updates: UpdateEntry[]) {
  const problems: string[] = [];
  if (updates.length !== 1) problems.push(`expected one update entry, found ${updates.length}`);
  const entry = updates[0] ?? {};
  if (entry["package-ecosystem"] !== "github-actions") problems.push("the entry must update github-actions");
  if (!Bun.deepEquals(entry.directories, ["/", "/.github/actions/setup-ci"])) problems.push("the entry must read the workflows and the setup-ci action");
  if (entry.schedule?.interval !== "monthly") problems.push("routine updates stay monthly");
  if (!Bun.deepEquals(entry.groups, { actions: { patterns: ["*"] } })) problems.push("all actions stay in one group");
  // Any other key (target-branch, open-pull-requests-limit, ...) can change how security updates arrive.
  for (const key of Object.keys(entry)) {
    if (!["package-ecosystem", "directories", "schedule", "groups", "cooldown"].includes(key)) problems.push(`unexpected key ${key}`);
  }
  if (entry.cooldown?.["default-days"] !== 7) problems.push("routine updates wait seven days");
  // GitHub applies `cooldown` to version updates only; tiers or extra rules are not part of this policy.
  for (const key of Object.keys(entry.cooldown ?? {})) {
    if (key !== "default-days") problems.push(`unexpected cooldown rule ${key}`);
  }
  return problems;
}

/** GitHub's documented rule, not a live Dependabot run: version updates skip releases younger than `default-days`. */
function heldBack(kind: "version" | "security", ageDays: number, entry: UpdateEntry) {
  return kind === "version" && ageDays < Number(entry.cooldown?.["default-days"] ?? 3);
}

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Workflow = { jobs?: Record<string, { uses?: string; steps?: Step[] }>; runs?: { steps: Step[] } };

const FULL_SHA = /^[0-9a-f]{40}$/;
const actionName = (uses: string) => uses.slice(0, uses.lastIndexOf("@"));
const actionFiles = [
  ...readdirSync(join(root, ".github/workflows")).filter((name) => name.endsWith(".yml")).map((name) => `.github/workflows/${name}`),
  ".github/actions/setup-ci/action.yml",
];

/** What is wrong with the action references of one workflow or composite action, step by step. */
function auditActions(file: string, text: string) {
  const doc = Bun.YAML.parse(text) as Workflow;
  const problems: string[] = [];
  const steps: Array<[string, Step]> = [];
  for (const [id, job] of Object.entries(doc.jobs ?? {})) {
    if (job.uses && !job.uses.startsWith("./")) problems.push(`${file} jobs.${id}: reusable workflow ${job.uses} is not local`);
    (job.steps ?? []).forEach((step, index) => steps.push([`jobs.${id}.steps[${index}]`, step]));
  }
  (doc.runs?.steps ?? []).forEach((step, index) => steps.push([`runs.steps[${index}]`, step]));
  for (const [where, step] of steps) {
    if (!step.uses || step.uses.startsWith("./")) continue;
    const at = `${file} ${where}${step.name ? ` (${step.name})` : ""}`;
    if (!FULL_SHA.test(step.uses.slice(step.uses.lastIndexOf("@") + 1))) problems.push(`${at}: ${step.uses} is not pinned to a full commit SHA`);
    if (actionName(step.uses) === "actions/checkout" && step.with?.["persist-credentials"] !== false) {
      problems.push(`${at}: checkout persists its Git credential`);
    }
  }
  // YAML parsing drops comments: the version Dependabot and readers go by is only in the text
  for (const [index, line] of text.split("\n").entries()) {
    const [, uses, comment] = line.match(/^\s*(?:- )?uses:\s*([^\s#]+)\s*(#.*)?$/) ?? [];
    if (!uses || uses.startsWith("./") || !FULL_SHA.test(uses.slice(uses.lastIndexOf("@") + 1))) continue;
    if (!/^# v\d+\.\d+\.\d+$/.test(comment?.trim() ?? "")) problems.push(`${file}:${index + 1}: ${uses} has no "# vX.Y.Z" version comment`);
  }
  return problems;
}

function prepared(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-preinstalled-"));
  const calls = join(dir, "calls");
  try {
    for (const name of ["bun", "node", "herdr", "sha256sum"]) {
      writeFileSync(join(dir, name), `#!/bin/sh
printf '%s\\n' '${name}' >> "$TEST_CALLS"
case '${name}' in
  bun) printf '%s\\n' "$TEST_BUN" ;;
  node) printf '%s\\n' "$TEST_NODE" ;;
  sha256sum) IFS= read -r line; exit "$TEST_CHECKSUM_EXIT" ;;
esac
`, { mode: 0o755 });
    }
    const result = spawnSync("bash", [join(root, "scripts/ci-preinstalled-tools.sh")], {
      encoding: "utf8", timeout: 5_000,
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        EXPECTED_BUN_VERSION: action.inputs["bun-version"]!.default,
        NEED_NODE: "true", NEED_HERDR: "true",
        TEST_BUN: action.inputs["bun-version"]!.default, TEST_NODE: "v22.23.3",
        TEST_CHECKSUM_EXIT: "0", TEST_CALLS: calls, ...overrides,
      },
    });
    expect(result.error).toBeUndefined();
    return { ...result, calls: result.status === 0 ? readFileSync(calls, "utf8") : "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("prepared CI tools", () => {
  it("checks the requested tools without downloading replacements", () => {
    const result = prepared();
    expect(result.status).toBe(0);
    expect(result.calls.trim().split("\n")).toEqual(["bun", "node", "sha256sum"]);
  });

  it("does not require optional tools for Bun-only jobs", () => {
    const result = prepared({ NEED_NODE: "false", NEED_HERDR: "false", TEST_NODE: "v18.0.0", TEST_CHECKSUM_EXIT: "1" });
    expect(result.status).toBe(0);
    expect(result.calls.trim()).toBe("bun");
  });

  for (const [name, env] of [
    ["stale Bun", { TEST_BUN: "1.0.0" }],
    ["wrong Node major", { TEST_NODE: "v24.0.0" }],
    ["untrusted herdr binary", { TEST_CHECKSUM_EXIT: "1" }],
    ["unsupported architecture", { RUNNER_ARCH: "ARM64" }],
    ["unsupported host OS", { RUNNER_OS: "Windows" }],
  ] as const) {
    it(`fails closed for ${name}`, () => {
      const result = prepared(env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Rebuild scripts/self-hosted-runner/Dockerfile");
    });
  }
});

describe("CI cache contract", () => {
  it("keeps the prepared image aligned with the workflow and lockfile", () => {
    const dockerfile = readFileSync(join(root, "scripts/self-hosted-runner/Dockerfile"), "utf8");
    const lockfile = readFileSync(join(root, "bun.lock"), "utf8");
    expect(dockerfile.match(/^ARG BUN_VERSION=(.+)$/m)?.[1]).toBe(action.inputs["bun-version"]!.default);
    const playwright = lockfile.match(/"playwright-core": \["playwright-core@([^"]+)"/)?.[1];
    expect(playwright).toBeDefined();
    expect(dockerfile.match(/^ARG PLAYWRIGHT_VERSION=(.+)$/m)?.[1]).toBe(playwright);
  });

  it("saves the dependency cache only when a job allows it", () => {
    const save = action.runs.steps.find((step) => step.name === "Cache Bun dependencies")!;
    const restore = action.runs.steps.find((step) => step.name === "Restore Bun dependencies (read-only)")!;
    expect(action.inputs.cache!.default).toBe("save");
    expect(save.if).toContain("inputs.cache != 'restore'");
    expect(restore.if).toContain("inputs.cache == 'restore'");
    expect(actionName(restore.uses!)).toBe("actions/cache/restore");
    expect(restore.with).toEqual(save.with);
    const canary = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/omp-question-compat.yml"), "utf8")) as {
      jobs: Record<string, { steps: Array<{ uses?: string; with?: Record<string, string> }> }>;
    };
    for (const job of Object.values(canary.jobs)) {
      expect(job.steps.find((step) => step.uses === "./.github/actions/setup-ci")!.with!.cache).toBe("restore");
    }
  });

  it("keeps dependency caches inside the workspace and separates runner environments", () => {
    const cache = action.runs.steps.find((step) => step.name === "Cache Bun dependencies")!;
    expect(cache.with!.path).toBe(".ci-cache/bun");
    expect(cache.with!.key).toContain("bun-workspace-v2-${{ runner.environment }}-");
    expect(cache.with!["restore-keys"]).toStartWith("bun-workspace-v2-${{ runner.environment }}-");
    const directory = action.runs.steps.find((step) => step.name === "Select workspace-local Bun cache")!;
    expect(directory.env!.BUN_CACHE_DIR).toBe(`\${{ github.workspace }}/${cache.with!.path}`);
  });

  it("does not transfer dependency or browser caches over the prepared image", () => {
    expectHostedOnlySetup(action);
    const workflow = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, { steps: Array<{ name?: string; if?: string; with?: Record<string, string> }> }>;
    };
    for (const job of ["browser-main", "browser-other"]) {
      const cache = workflow.jobs[job]!.steps.find((step) => step.name === "Cache Playwright browser")!;
      expect(cache.if).toContain("runner.environment != 'self-hosted'");
      expect(cache.with!.path).toBe(".ci-cache/playwright");
      expect(cache.with!.key).toStartWith("playwright-workspace-v2-");
    }
  });

  it.skipIf(process.platform === "win32")("restores dependency cache contents across different checkout depths", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-cache-layout-"));
    try {
      const hosted = join(dir, "home/runner/work/repo/repo");
      const selfHosted = join(dir, "w/repo/repo");
      const path = action.runs.steps.find((step) => step.name === "Cache Bun dependencies")!.with!.path!;
      mkdirSync(join(hosted, path), { recursive: true });
      mkdirSync(selfHosted, { recursive: true });
      writeFileSync(join(hosted, path, "dependency"), "cached bytes");
      const archive = join(dir, "cache.tgz");
      const pack = spawnSync("tar", ["-czf", archive, "-C", hosted, path], { timeout: 5_000 });
      expect(pack.status).toBe(0);
      const unpack = spawnSync("tar", ["-xzf", archive, "-C", selfHosted], { timeout: 5_000 });
      expect(unpack.status).toBe(0);
      expect(readFileSync(join(selfHosted, path, "dependency"), "utf8")).toBe("cached bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("action pins and checkout credentials", () => {
  it("pins every external action to a full commit SHA and keeps local actions and workflows relative", () => {
    const names = new Set<string>();
    for (const file of actionFiles) {
      const text = readFileSync(join(root, file), "utf8");
      expect(auditActions(file, text)).toEqual([]);
      for (const [, uses] of text.matchAll(/uses:\s*([^\s#]+)/g)) if (!uses!.startsWith("./")) names.add(actionName(uses!));
    }
    expect([...names].sort()).toEqual([
      "actions/cache", "actions/cache/restore", "actions/checkout", "actions/deploy-pages", "actions/download-artifact",
      "actions/setup-node", "actions/upload-artifact", "actions/upload-pages-artifact", "oven-sh/setup-bun",
    ]);
    const actions = dependabot.updates.find((update) => update["package-ecosystem"] === "github-actions")!;
    expect(actions.directories).toEqual(["/", "/.github/actions/setup-ci"]);
  });

  it("names the step of a floating action, a missing version comment and a persisted checkout credential", () => {
    const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
    const fixture = `jobs:
  build:
    steps:
      - uses: actions/checkout@v7
      - name: Set up Bun
        uses: oven-sh/setup-bun@v2
      - name: Cache
        uses: actions/cache@v4
      - uses: actions/checkout@${sha} # v7.0.1
        with:
          fetch-depth: 0
      - uses: actions/cache/restore@${sha}
      - uses: ./.github/actions/setup-ci
  call:
    uses: someone/repo/.github/workflows/ci.yml@main
`;
    expect(auditActions("fixture.yml", fixture)).toEqual([
      "fixture.yml jobs.call: reusable workflow someone/repo/.github/workflows/ci.yml@main is not local",
      "fixture.yml jobs.build.steps[0]: actions/checkout@v7 is not pinned to a full commit SHA",
      "fixture.yml jobs.build.steps[0]: checkout persists its Git credential",
      "fixture.yml jobs.build.steps[1] (Set up Bun): oven-sh/setup-bun@v2 is not pinned to a full commit SHA",
      "fixture.yml jobs.build.steps[2] (Cache): actions/cache@v4 is not pinned to a full commit SHA",
      "fixture.yml jobs.build.steps[3]: checkout persists its Git credential",
      `fixture.yml:12: actions/cache/restore@${sha} has no "# vX.Y.Z" version comment`,
    ]);
  });
});

/** A public origin served from disk, a checkout of it holding no credential, and stub bun and gh. */
function fetchFixture() {
  const dir = mkdtempSync(join(tmpdir(), "ci-fetch-"));
  const stubs = join(dir, "stubs");
  mkdirSync(stubs);
  writeFileSync(join(dir, "gitconfig"), "");
  const env: Record<string, string> = {
    PATH: `${stubs}:${process.env.PATH ?? ""}`, HOME: dir, GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "CI fixture", GIT_AUTHOR_EMAIL: "ci@example.invalid",
    GIT_COMMITTER_NAME: "CI fixture", GIT_COMMITTER_EMAIL: "ci@example.invalid", TEST_CALLS: join(dir, "calls"), RUNNER_TEMP: dir,
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 10_000 });
    expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
    return result.stdout.trim();
  };
  // the publish step's stand-ins: gh records whether it got a token, never the token itself
  writeFileSync(join(stubs, "gh"), `#!/bin/sh\nprintf 'gh %s token=%s\\n' "$*" "\${GH_TOKEN:+set}" >> "$TEST_CALLS"\n`, { mode: 0o755 });
  writeFileSync(join(stubs, "bun"), `#!/bin/sh
case "$1" in
  scripts/release-notes.ts) printf 'notes for %s\\n' "$2" ;;
  scripts/release-guards.ts) printf 'guards tags=%s base=%s\\n' "$(git tag -l | tr '\\n' ' ')" "$(git cat-file -t "$3^{commit}" 2>&1)" >> "$TEST_CALLS" ;;
esac
`, { mode: 0o755 });
  const seed = join(dir, "seed");
  git(dir, "init", "-q", "-b", "main", seed);
  git(seed, "commit", "-q", "--allow-empty", "-m", "first");
  const first = git(seed, "rev-parse", "HEAD");
  git(seed, "commit", "-q", "--allow-empty", "-m", "validated");
  const validated = git(seed, "rev-parse", "HEAD");
  const origin = join(dir, "origin.git");
  git(dir, "clone", "-q", "--bare", seed, origin);
  // GitHub serves any reachable commit by SHA; a shallow fetch of the PR base relies on it
  git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  return { dir, env, git, seed, origin, first, validated, calls: () => {
    try { return readFileSync(env.TEST_CALLS!, "utf8").trim().split("\n"); } catch { return []; }
  } };
}

/** Runs one workflow step's script the way a runner's bash does. */
function runStep(file: string, job: string, name: string, cwd: string, env: Record<string, string>) {
  const workflow = Bun.YAML.parse(readFileSync(join(root, file), "utf8")) as Workflow;
  const script = workflow.jobs![job]!.steps!.find((step) => step.name === name)!.run!;
  expect(script).not.toContain("${{");
  const path = join(env.RUNNER_TEMP!, `${job}-step.sh`);
  writeFileSync(path, script);
  return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", path], { cwd, env, encoding: "utf8", timeout: 20_000 });
}

/** Where a token ended up: the step's output, the checkout's remote URL or its Git config. */
function credentialLeaks(git: (cwd: string, ...args: string[]) => string, checkout: string, token: string, output: string) {
  const leaks: string[] = [];
  if (output.includes(token)) leaks.push("output");
  if (git(checkout, "remote", "-v").includes(token)) leaks.push("remote URL");
  const config = git(checkout, "config", "--list", "--show-origin");
  if (config.includes(token)) leaks.push("git config");
  if (/extraheader/i.test(config)) leaks.push("persisted checkout header");
  return leaks;
}

describe.skipIf(process.platform === "win32")("fetches without a persisted checkout credential", () => {
  const token = "ghs_fixtureTokenThatMustNotLeak0123456789";

  it("publishes a release with tags fetched anonymously and gh authenticated by GH_TOKEN alone", () => {
    const f = fetchFixture();
    try {
      const checkout = join(f.dir, "checkout");
      f.git(f.dir, "clone", "-q", `file://${f.origin}`, checkout);
      // after the checkout: an older release tag and a newer main commit land on origin
      f.git(f.seed, "tag", "-a", "v1.0.0", "-m", "v1.0.0", f.first);
      f.git(f.seed, "commit", "-q", "--allow-empty", "-m", "later");
      f.git(f.seed, "push", "-q", f.origin, "main", "v1.0.0");
      const env = { ...f.env, GH_TOKEN: token, GH_REPO: "owner/repo", GITHUB_SHA: f.validated, RELEASE_VERSION: "1.1.0" };
      const result = runStep(".github/workflows/release.yml", "publish", "Publish the validated commit", checkout, env);
      expect(result.status, result.stderr).toBe(0);
      expect(f.git(checkout, "rev-parse", "refs/tags/v1.0.0^{commit}")).toBe(f.first);
      expect(f.git(checkout, "rev-parse", "origin/main")).toBe(f.git(f.seed, "rev-parse", "HEAD"));
      expect(f.calls()).toEqual([
        `gh release create v1.1.0 --target ${f.validated} --title Ovis v1.1.0 --notes-file ${f.dir}/release-notes.md token=set`,
      ]);
      expect(credentialLeaks(f.git, checkout, token, result.stdout + result.stderr)).toEqual([]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses to publish when the fetch fails or the tag already exists", () => {
    const f = fetchFixture();
    try {
      const checkout = join(f.dir, "checkout");
      f.git(f.dir, "clone", "-q", `file://${f.origin}`, checkout);
      f.git(f.seed, "tag", "-a", "v1.0.0", "-m", "v1.0.0", f.first);
      f.git(f.seed, "push", "-q", f.origin, "v1.0.0");
      const env = { ...f.env, GH_TOKEN: token, GH_REPO: "owner/repo", GITHUB_SHA: f.validated };
      const taken = runStep(".github/workflows/release.yml", "publish", "Publish the validated commit", checkout, { ...env, RELEASE_VERSION: "1.0.0" });
      expect(taken.status).toBe(1);
      expect(taken.stderr).toContain("Tag appeared during validation");
      f.git(checkout, "remote", "set-url", "origin", `file://${join(f.dir, "missing.git")}`);
      const unreachable = runStep(".github/workflows/release.yml", "publish", "Publish the validated commit", checkout, { ...env, RELEASE_VERSION: "1.1.0" });
      expect(unreachable.status).not.toBe(0);
      expect(f.calls()).toEqual([]);
      expect(credentialLeaks(f.git, checkout, token, taken.stdout + taken.stderr + unreachable.stdout + unreachable.stderr)).toEqual([]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("gives the release guards their tags and base commit from a shallow checkout", () => {
    const f = fetchFixture();
    try {
      f.git(f.seed, "tag", "-a", "v1.0.0", "-m", "v1.0.0", f.first);
      f.git(f.seed, "tag", "-a", "remote-v1", "-m", "remote-v1", f.first);
      f.git(f.seed, "commit", "-q", "--allow-empty", "-m", "pull request head");
      f.git(f.seed, "push", "-q", f.origin, "main", "v1.0.0", "remote-v1");
      const checkout = join(f.dir, "checkout");
      f.git(f.dir, "clone", "-q", "--depth=1", "--no-tags", `file://${f.origin}`, checkout);
      expect(spawnSync("git", ["cat-file", "-e", `${f.validated}^{commit}`], { cwd: checkout, env: f.env }).status).not.toBe(0);
      const result = runStep(".github/workflows/ci.yml", "fast", "Release guards", checkout, { ...f.env, BASE_SHA: f.validated });
      expect(result.status, result.stderr).toBe(0);
      expect(f.calls()).toEqual(["guards tags=remote-v1 v1.0.0  base=commit"]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("finds a token left in output, a remote URL or the Git config", () => {
    const f = fetchFixture();
    try {
      const checkout = join(f.dir, "checkout");
      f.git(f.dir, "clone", "-q", `file://${f.origin}`, checkout);
      expect(credentialLeaks(f.git, checkout, token, "")).toEqual([]);
      f.git(checkout, "remote", "set-url", "origin", `https://x-access-token:${token}@github.com/owner/repo`);
      f.git(checkout, "config", "http.https://github.com/.extraheader", `AUTHORIZATION: basic ${token}`);
      expect(credentialLeaks(f.git, checkout, token, `token ${token}`)).toEqual(["output", "remote URL", "git config", "persisted checkout header"]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("Actions update policy", () => {
  it("delays routine Actions updates seven days and keeps the monthly group", () => {
    expect(actionsPolicyProblems(dependabot.updates)).toEqual([]);
    expect(dependabot.updates[0]!.cooldown).toEqual({ "default-days": 7 });
    // A release from today, three days ago (GitHub's implicit default) and a week ago.
    expect([0, 3, 6, 7, 30].map((age) => heldBack("version", age, dependabot.updates[0]!))).toEqual([true, true, true, false, false]);
  });

  it("never delays security updates", () => {
    expect(heldBack("security", 0, dependabot.updates[0]!)).toBe(false);
    const entry = dependabot.updates[0]!;
    for (const [name, updates] of [
      ["a security cooldown", [{ ...entry, cooldown: { "default-days": 7, "security-days": 7 } }]],
      ["semver tiers", [{ ...entry, cooldown: { "default-days": 7, "semver-major-days": 28 } }]],
      ["a second entry", [entry, { ...entry, directories: ["/site"] }]],
      ["a pull request limit", [{ ...entry, "open-pull-requests-limit": 0 }]],
      ["no cooldown", [{ ...entry, cooldown: undefined }]],
      ["a weekly schedule", [{ ...entry, schedule: { interval: "weekly" } }]],
    ] as const) {
      expect(actionsPolicyProblems([...updates] as UpdateEntry[]), name).not.toEqual([]);
    }
  });

  it("accepts an urgent fix pinned to a commit SHA released today", () => {
    // Stands in for a reviewed patched commit; nothing local asks how old it is.
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const pinned = Bun.YAML.parse(actionSource.replace(/^(\s*(?:- )?uses: [\w./-]+)@\S+/gm, `$1@${sha}`)) as SetupAction;
    const refs = pinned.runs.steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toEndWith(`@${sha}`);
    expectHostedOnlySetup(pinned);
    expect(pinned.runs.steps.find(usesAction("actions/cache/restore"))!.with).toEqual(action.runs.steps.find(usesAction("actions/cache/restore"))!.with);
    expect(actionsPolicyProblems(dependabot.updates)).toEqual([]);
  });
});
