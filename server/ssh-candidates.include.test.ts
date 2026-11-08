import { expect, it, spyOn } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { basename, join } from "node:path";

import { sshCandidates } from "./ssh-candidates.ts";
import { sshDir, twoPeers } from "./ssh-candidates.fixture.ts";

// the files an Include of the ssh config names: which ones are read, how far a wildcard goes, and the read budget

it.skipIf(process.platform === "win32")("reads an Include only inside the home or ssh folder, never through an absolute path, `..` or a link out of them", async () => {
  const home = sshDir({ ".ssh/config": "", "notes/hosts": "Host in-home\n" });
  const outside = sshDir({ secret: "Host leaked\n  HostName secret.example\n  User root\n" });
  symlinkSync(join(outside, "secret"), join(home, ".ssh", "link"));
  writeFileSync(join(home, ".ssh", "config"), [
    `Include ${join(outside, "secret")}`, `Include ../../${basename(outside)}/secret`, "Include link", `Include ${outside}/*`,
    "Include ~/notes/hosts", "Host own",
  ].join("\n"));
  const candidates = await sshCandidates({ sshDir: join(home, ".ssh"), home, readStatus: async () => null });
  expect(candidates.map((candidate) => candidate.name)).toEqual(["in-home", "own"]);
});

it.skipIf(process.platform === "win32")("follows a glob Include's link whose target stays in the home folder, as ssh -G does", async () => {
  const home = sshDir({ "dotfiles/box.conf": "Host box\n  HostName 100.64.0.2\n", ".ssh/config": "Include conf.d/*\nHost box\n  HostName 100.64.0.1\n" });
  mkdirSync(join(home, ".ssh", "conf.d"));
  symlinkSync(join(home, "dotfiles", "box.conf"), join(home, ".ssh", "conf.d", "box.conf"));
  const candidates = await sshCandidates({ sshDir: join(home, ".ssh"), home, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.detail, candidate.tailnet])).toEqual([
    ["box", "100.64.0.2", "other.tail.ts.net"], ["box", "box.tail.ts.net", "box.tail.ts.net"],
  ]);
});

it.skipIf(process.platform === "win32")("claims nothing for a host a glob Include's link out of the home folder may set", async () => {
  const outside = sshDir({ "box.conf": "Host box\n  HostName 100.64.0.2\n" });
  const home = sshDir({ ".ssh/config": "Include conf.d/*\nHost box\n  HostName 100.64.0.1\n" });
  mkdirSync(join(home, ".ssh", "conf.d"));
  symlinkSync(join(outside, "box.conf"), join(home, ".ssh", "conf.d", "box.conf"));
  const candidates = await sshCandidates({ sshDir: join(home, ".ssh"), home, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
});

it.skipIf(process.platform === "win32")("skips an included FIFO or oversized file without waiting on it or reading it", async () => {
  const home = sshDir({ ".ssh/big": `Host too-big\n${"#".repeat(300 * 1024)}\n`, ".ssh/small": "Host small\n", ".ssh/config": "Include pipe\nInclude big\nInclude small\n" });
  await Bun.$`mkfifo ${join(home, ".ssh", "pipe")}`;
  const candidates = await sshCandidates({ sshDir: join(home, ".ssh"), home, readStatus: async () => null });
  expect(candidates.map((candidate) => candidate.name)).toEqual(["small"]);
});

it("reads at most 64 included files across every Include", async () => {
  const files: Record<string, string> = { config: "Include a/*\nInclude b/*\n" };
  for (let index = 0; index < 40; index++) {
    files[`a/${String(index).padStart(2, "0")}`] = `Host a${index}\n`;
    files[`b/${String(index).padStart(2, "0")}`] = `Host b${index}\n`;
  }
  const dir = sshDir(files);
  expect(await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => null })).toHaveLength(64);
});

it("claims nothing for a later host once a glob Include goes past the included-file budget", async () => {
  const files: Record<string, string> = { config: "Include a/*\nHost box\n  HostName 100.64.0.1\n" };
  for (let index = 0; index < 65; index++) files[`a/${String(index).padStart(2, "0")}`] = "# nothing here\n";
  const dir = sshDir(files);
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
});

it("claims nothing for a host a glob Include past the file budget may set before the files it read", async () => {
  const files: Record<string, string> = { config: "Include a/*\n" };
  const route = "Host box\n  HostName 100.64.0.1\n  AddressFamily inet\n  ProxyCommand none\n  ProxyJump none\n  CanonicalizeHostname no\n";
  for (let index = 0; index < 65; index++) files[`a/${String(index).padStart(2, "0")}`] = route;
  const dir = sshDir(files);
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
});

it("claims nothing for a host an Include with a token or environment variable may set, never expanding it", async () => {
  const dir = sshDir({ config: "Include ${HOME}/.ssh/conf.d/*\nHost box\n  HostName 100.64.0.1\n" });
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
});

it.skipIf(process.platform === "win32")("never lists a folder a wildcard Include reaches through a link out of the home folder, and claims nothing it may set", async () => {
  const outside = sshDir({ "box.conf": "Host box\n  HostName 100.64.0.2\n" });
  const home = sshDir({ ".ssh/conf.d/own/hosts": "Host own\n", ".ssh/config": "Include conf.d/*/*\nHost box\n  HostName 100.64.0.1\n" });
  symlinkSync(outside, join(home, ".ssh", "conf.d", "link"));
  const listing = spyOn(fsPromises, "readdir");
  try {
    const candidates = await sshCandidates({ sshDir: join(home, ".ssh"), home, readStatus: async () => twoPeers });
    const listed = listing.mock.calls.map(([dir]) => String(dir));
    expect(listed).toEqual([realpathSync(join(home, ".ssh", "conf.d")), realpathSync(join(home, ".ssh", "conf.d", "own"))]);
    expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([
      ["own", undefined], ["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"],
    ]);
  } finally { listing.mockRestore(); }
});
