import { expect, test } from "bun:test";
import { join } from "node:path";
import { EXTRA_PLATFORMS } from "./server-manifest.ts";
import { EXTRA_BINARIES, RELEASE_BINARIES } from "./release-binaries.ts";
import { type Job, parseWorkflow, root } from "./shell-workflow-rules.ts";

/**
 * A release carries the server and the Rust PTY host alone (todo 66): the extra binaries (scripts/release-binaries.ts)
 * stay buildable, each by its own workflow run by hand, and none of them reaches the release or its signed manifest.
 */
const workflow = (name: string) => parseWorkflow(join(root, ".github/workflows", name));
const release = workflow("release.yml");
const job = (name: string): Job => release.jobs[name]!;
const ATTESTS = { contents: "read", "id-token": "write", attestations: "write" };
const BUILDS: Record<string, string> = { "ovis-link": "link-binary" };
const runs = (candidate: Job) => candidate.steps!.map((step) => step.run ?? "").join("\n");

test("the release builds, signs and attaches no extra binary", () => {
  expect(RELEASE_BINARIES).toEqual([]);
  const called = Object.values(release.jobs).map((candidate) => candidate.uses).filter(Boolean);
  for (const id of Object.values(BUILDS)) expect(called).not.toContain(`./.github/workflows/${id}.yml`);
  expect([job("server-binary").needs].flat()).toEqual(["preflight", "pty-sidecar"]);
  expect([job("publish").needs].flat()).toEqual(["validate", "pty-sidecar", "server-binary-sign", "server-binary-attest"]);
  const downloads = (id: string) => job(id).steps!.filter((step) => step.uses?.startsWith("actions/download-artifact@")).map((step) => step.with?.["name"]);
  expect(downloads("server-binary")).toEqual(["ovis-pty-sidecar"]);
  expect(downloads("publish")).toEqual(["ovis-pty-sidecar", "ovis-server"]);
  const publish = job("publish").steps!.find((candidate) => candidate.name === "Publish the validated commit")!.run!;
  const create = publish.split("\n").find((line) => line.includes("gh release create"))!;
  expect(create).toContain('"$RUNNER_TEMP"/pty-sidecar/* "${server_files[@]/#/$RUNNER_TEMP/server-binary/}"');
  for (const binary of EXTRA_BINARIES) expect(JSON.stringify(release)).not.toContain(binary);
});

test("each extra binary is built by hand only, for the four Linux and macOS platforms, with its manifest and attestation", () => {
  expect(Object.keys(BUILDS)).toEqual([...EXTRA_BINARIES]);
  for (const binary of EXTRA_BINARIES) {
    const called = workflow(`${BUILDS[binary]!}.yml`);
    expect(Object.keys(called.on)).toEqual(["workflow_dispatch"]);
    expect((called.on["workflow_dispatch"] as { inputs: Record<string, unknown> }).inputs).toEqual({ ref: { description: "Commit to build", required: true, type: "string" } });
    expect(called.permissions).toEqual({ contents: "read" });
    const build = called.jobs["build"] as Job & { strategy: { matrix: { include: { platform: string }[] } } };
    expect(build.strategy.matrix.include.map((entry) => entry.platform)).toEqual([...EXTRA_PLATFORMS]);
    expect(build.permissions).toBeUndefined();
    const upload = build.steps!.find((step) => step.uses?.startsWith("actions/upload-artifact@"))!;
    expect(upload.with?.["path"]).toBe(`out/${binary}-\${{ matrix.platform }}`);
    const manifest = called.jobs["manifest"]!;
    expect(runs(manifest)).toContain(`bun scripts/release-binaries.ts manifest ${binary} out`);
    const artifact = manifest.steps!.find((step) => step.uses?.startsWith("actions/upload-artifact@"))!;
    expect(artifact.with?.["name"]).toBe(binary);
    const attest = called.jobs["attest"]!;
    expect(attest.needs).toBe("manifest");
    expect(attest.permissions).toEqual(ATTESTS);
    expect(attest.steps!.find((step) => step.uses?.startsWith("actions/attest-build-provenance@"))?.with).toEqual({ "subject-path": `out/${binary}-*` });
  }
});

test("each build job builds with its own script", () => {
  const link = workflow("link-binary.yml").jobs["build"]!;
  expect(runs(link)).toContain("cargo test --locked --manifest-path crates/fleet-link/Cargo.toml");
  expect(runs(link)).toContain("bun scripts/build-link.ts ${{ matrix.platform }} out");
});
