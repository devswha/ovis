import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP, mirrorOnce, REPOSITORY } from "./shell-mirror.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-shell-mirror-"));
  dirs.push(dir);
  return dir;
}

const LIVE = "a".repeat(40);
const OLDER = "b".repeat(40);

/** A release's dist-shell.tar.gz, built by the real tar, holding a build.json for `revision`. */
async function tarball(revision: string, index = "<!doctype html>"): Promise<Uint8Array> {
  const src = temp();
  writeFileSync(join(src, "build.json"), JSON.stringify({ revision }));
  writeFileSync(join(src, "index.html"), index);
  const out = join(temp(), "dist-shell.tar.gz");
  await Bun.$`tar -czf ${out} -C ${src} .`.quiet();
  return new Uint8Array(readFileSync(out));
}

function github(releases: { tag: string; commit: string; archive: Uint8Array; digest?: string }[], live = LIVE) {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url === `${APP}/build.json`) return Response.json({ revision: live });
    if (url.startsWith(`https://api.github.com/repos/${REPOSITORY}/releases`)) {
      return Response.json(releases.map(({ tag }) => ({ tag_name: tag, assets: [
        { name: "dist-shell.tar.gz", browser_download_url: `https://dl.test/${tag}/dist-shell.tar.gz` },
        { name: "dist-shell.tar.gz.sha256", browser_download_url: `https://dl.test/${tag}/dist-shell.tar.gz.sha256` },
      ] })));
    }
    for (const release of releases) {
      if (url === `https://api.github.com/repos/${REPOSITORY}/commits/${release.tag}`) return Response.json({ sha: release.commit });
      if (url === `https://dl.test/${release.tag}/dist-shell.tar.gz`) return new Response(new Blob([release.archive.slice()]));
      if (url === `https://dl.test/${release.tag}/dist-shell.tar.gz.sha256`) {
        return new Response(`${release.digest ?? createHash("sha256").update(release.archive).digest("hex")}  dist-shell.tar.gz\n`);
      }
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetcher, asked };
}

it("serves the release built from the commit app.ovis.sh serves, and does nothing once it does", async () => {
  const dir = temp();
  const { fetcher } = github([
    { tag: "v0.4.23", commit: OLDER, archive: await tarball(OLDER) },
    { tag: "v0.4.22", commit: LIVE, archive: await tarball(LIVE, "live") },
  ]);
  expect(await mirrorOnce({ dir, fetch: fetcher })).toEqual({ kind: "updated", tag: "v0.4.22", revision: LIVE });
  expect(readlinkSync(join(dir, "current"))).toBe(join("releases", "v0.4.22"));
  expect(readFileSync(join(dir, "current", "index.html"), "utf8")).toBe("live");
  expect(await mirrorOnce({ dir, fetch: fetcher })).toEqual({ kind: "current", revision: LIVE });
});

it("refuses a tarball that does not match its published SHA-256, and keeps serving what it served", async () => {
  const dir = temp();
  const first = github([{ tag: "v0.4.21", commit: OLDER, archive: await tarball(OLDER) }], OLDER);
  await mirrorOnce({ dir, fetch: first.fetcher });
  const tampered = github([{ tag: "v0.4.22", commit: LIVE, archive: await tarball(LIVE), digest: "0".repeat(64) }]);
  await expect(mirrorOnce({ dir, fetch: tampered.fetcher })).rejects.toThrow("published SHA-256");
  expect(readlinkSync(join(dir, "current"))).toBe(join("releases", "v0.4.21"));
});

it("refuses a release whose build.json names another commit than its tag", async () => {
  const dir = temp();
  const { fetcher } = github([{ tag: "v0.4.22", commit: LIVE, archive: await tarball(OLDER) }]);
  await expect(mirrorOnce({ dir, fetch: fetcher })).rejects.toThrow("not " + LIVE);
  expect(() => readlinkSync(join(dir, "current"))).toThrow();
});

it("refuses a tarball that holds a link", async () => {
  const dir = temp();
  const src = temp();
  writeFileSync(join(src, "build.json"), JSON.stringify({ revision: LIVE }));
  mkdirSync(join(src, "assets"));
  await Bun.$`ln -s /etc/passwd ${join(src, "assets", "x")}`.quiet();
  const out = join(temp(), "dist-shell.tar.gz");
  await Bun.$`tar -czf ${out} -C ${src} .`.quiet();
  const { fetcher } = github([{ tag: "v0.4.22", commit: LIVE, archive: new Uint8Array(readFileSync(out)) }]);
  await expect(mirrorOnce({ dir, fetch: fetcher })).rejects.toThrow("link");
});

it("serves nothing when no release was built from that commit", async () => {
  const dir = temp();
  const { fetcher } = github([{ tag: "v0.4.21", commit: OLDER, archive: await tarball(OLDER) }]);
  await expect(mirrorOnce({ dir, fetch: fetcher })).rejects.toThrow("no release");
});
