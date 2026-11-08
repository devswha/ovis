import { expect, it, spyOn } from "bun:test";
import { mkdirSync, type PathLike, renameSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * Runs `swap` right after the code under test first resolves or opens `path`: the moment between a check of a path and
 * its use, where a folder or file on the way can be replaced by a link
 */
function swapAfterFirstLook(path: string, swap: () => void): () => void {
  const [realpath, open] = [fsPromises.realpath, fsPromises.open];
  let swapped = false;
  const after = <T>(value: T, looked: unknown): T => {
    if (!swapped && String(looked) === path) { swapped = true; swap(); }
    return value;
  };
  const spies = [
    // the code under test resolves paths without options
    spyOn(fsPromises, "realpath").mockImplementation((async (looked: PathLike) => after(await realpath(looked), looked)) as typeof realpath),
    spyOn(fsPromises, "open").mockImplementation(async (...args: Parameters<typeof open>) => after(await open(...args), args[0])),
  ];
  return () => { for (const spy of spies) spy.mockRestore(); };
}

/** a home whose ssh folder holds `files`, and a folder outside it whose `evil` links back to the home's `notes/leak` */
function homeAndOutside(files: Record<string, string>): { home: string; ssh: string; outside: string } {
  const home = sshDir({ "notes/leak": "Host leaked\n", ...Object.fromEntries(Object.entries(files).map(([name, text]) => [`.ssh/${name}`, text])) });
  const outside = sshDir({});
  symlinkSync(join(home, "notes", "leak"), join(outside, "evil"));
  return { home, ssh: join(home, ".ssh"), outside };
}

it.skipIf(process.platform === "win32")("never lists a folder a wildcard Include reaches through a link out of the home folder, and claims nothing it may set", async () => {
  const { home, ssh, outside } = homeAndOutside({ "conf.d/own/hosts": "Host own\n", config: "Include conf.d/*/*\nHost box\n  HostName 100.64.0.1\n" });
  symlinkSync(outside, join(ssh, "conf.d", "link"));
  const candidates = await sshCandidates({ sshDir: ssh, home, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([
    ["own", undefined], ["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"],
  ]);
});

it.skipIf(process.platform === "win32")("never lists a folder swapped for a link out of the home folder after it was checked", async () => {
  const { home, ssh, outside } = homeAndOutside({ "conf.d/own/hosts": "Host own\n", config: "Include conf.d/*/*\n" });
  const folder = join(ssh, "conf.d", "own");
  const restore = swapAfterFirstLook(folder, () => { renameSync(folder, `${folder}.old`); symlinkSync(outside, folder); });
  try {
    const candidates = await sshCandidates({ sshDir: ssh, home, readStatus: async () => null });
    expect(candidates.map((candidate) => candidate.name)).toEqual([]);
  } finally { restore(); }
});

it.skipIf(process.platform === "win32")("never reads a file swapped for a link out of the home folder after it was checked", async () => {
  const { home, ssh, outside } = homeAndOutside({ "conf.d/x.conf": "Host own\n", config: "Include conf.d/*.conf\n" });
  writeFileSync(join(outside, "secret"), "Host leaked\n");
  const file = join(ssh, "conf.d", "x.conf");
  const restore = swapAfterFirstLook(file, () => { renameSync(file, `${file}.old`); symlinkSync(join(outside, "secret"), file); });
  try {
    const candidates = await sshCandidates({ sshDir: ssh, home, readStatus: async () => null });
    expect(candidates.map((candidate) => candidate.name)).toEqual(["own"]);
  } finally { restore(); }
});

it("claims nothing for a later host once the folder entries every Include looks at pass their budget, matching or not", async () => {
  const files: Record<string, string> = { config: "Include conf.d/*.conf\nInclude conf.d/*.conf\nHost box\n  HostName 100.64.0.1\n" };
  for (let index = 0; index < 600; index++) files[`conf.d/n${String(index).padStart(3, "0")}`] = "";
  const dir = sshDir(files);
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
});

it.skipIf(process.platform === "win32")("reads the files a wildcard matches in the order of the links' own names, not of their targets", async () => {
  const home = sshDir({ "z/hosts": "Host box\n  HostName 100.64.0.1\n", "a/hosts": "Host box\n  HostName 100.64.0.2\n", ".ssh/config": "Include conf.d/*/hosts\n" });
  mkdirSync(join(home, ".ssh", "conf.d"));
  symlinkSync(join(home, "z"), join(home, ".ssh", "conf.d", "a"));
  symlinkSync(join(home, "a"), join(home, ".ssh", "conf.d", "b"));
  const candidates = await sshCandidates({ sshDir: join(home, ".ssh"), home, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.detail, candidate.tailnet])).toEqual([
    ["box", "100.64.0.1", "box.tail.ts.net"], ["other", "other.tail.ts.net", "other.tail.ts.net"],
  ]);
});

it.skipIf(process.platform === "win32")("claims nothing for a host a glob(3) feature not matched exactly here may set, and reads an escaped name as glob(3) does", async () => {
  const classed = sshDir({ "conf.d/1.conf": "Host box\n  HostName 100.64.0.2\n", config: "Include conf.d/[[:digit:]].conf\nHost box\n  HostName 100.64.0.1\n" });
  const escaped = sshDir({ "conf.d/d/x.conf": "Host esc\n", "conf.d/a*b": "Host star\n", "conf.d/axb": "Host other-file\n", config: "Include conf.d/*/x\\.conf conf.d/a\\*b\n" });
  const fromClass = await sshCandidates({ sshDir: classed, home: classed, readStatus: async () => twoPeers });
  expect(fromClass.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
  expect((await sshCandidates({ sshDir: escaped, home: escaped, readStatus: async () => null })).map((candidate) => candidate.name)).toEqual(["esc", "star"]);
});

it("claims nothing for a host an Include of another user's home (~user) may set", async () => {
  const dir = sshDir({ config: "Include ~someone/.ssh/hosts\nHost box\n  HostName 100.64.0.1\n" });
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
});
