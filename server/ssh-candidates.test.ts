import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { sshCandidates, sshConfigHosts } from "./ssh-candidates.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function sshDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-ssh-candidates-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** `tailscale status --json` with this PC as user 1 and the named peers online, of the same login */
const status = (peers: string[]): string => JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "self.tail.ts.net.", UserID: 1 },
  Peer: Object.fromEntries(peers.map((name, index) => [`k${index}`, { DNSName: `${name}.tail.ts.net.`, UserID: 1, Online: true, OS: "linux" }])),
});

it("lists the hosts a config names with their first HostName and User, leaving out patterns and Match", async () => {
  const hosts = await sshConfigHosts([
    "# a comment",
    "Host *",
    "  User everyone",
    "Host nuc12 nuc",
    "  HostName 100.127.218.1",
    "  User rise",
    "  User ignored",
    "Host web-*",
    "  HostName web.example",
    "Host=github.com",
    "  User git",
    "Match host something",
    "  HostName matched.example",
    "Host \"quoted\"",
    "  HostName=q.example",
    "Host keep db-* !nuc",
    "  User k",
    "Host nuc",
    "  HostName later.example",
  ].join("\n"));
  expect(hosts).toEqual([
    { alias: "nuc12", hostname: "100.127.218.1", user: "rise" },
    { alias: "nuc", hostname: "100.127.218.1", user: "rise" },
    { alias: "github.com", hostname: null, user: "git" },
    { alias: "quoted", hostname: "q.example", user: null },
    { alias: "keep", hostname: null, user: "k" },
  ]);
});

it("leaves out an alias a negated pattern on its own Host line matches, as ssh does", async () => {
  expect(await sshConfigHosts("Host web01 !web*\n  User skipped\nHost db01 !web*\n  User kept\n")).toEqual([{ alias: "db01", hostname: null, user: "kept" }]);
});

it("matches a negated pattern in linear time, so a crafted one cannot hold the server", async () => {
  const alias = "a".repeat(45);
  const started = performance.now();
  const hosts = await sshConfigHosts(`Host ${alias} !${"*a".repeat(12)}b\nHost w0b01 !w?b*\nHost web02 !*0?\n`);
  expect(performance.now() - started).toBeLessThan(250);
  expect(hosts.map((host) => host.alias)).toEqual([alias]);
});

it("starts each file one Include names in the Host block of the Include", async () => {
  const dir = sshDir({ config: "Host lab\n  Include a b\n", a: "Host other\n", b: "User alice\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => null });
  expect(candidates.map((candidate) => [candidate.name, candidate.detail])).toEqual([["lab", "alice@lab"], ["other", null]]);
});

it("stops a line at a word that starts a comment", async () => {
  expect(await sshConfigHosts("Host lab # work machine\n  HostName lab.example # the desk\n")).toEqual([{ alias: "lab", hostname: "lab.example", user: null }]);
});

it("reads an Include inside a Host block as part of that block", async () => {
  const dir = sshDir({ config: "Host lab\n  Include lab.conf\nHost after\n", "lab.conf": "HostName lab-pc.tail.ts.net\nUser alice\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => status(["lab-pc"]), resolve: async () => [] });
  expect(candidates.map((candidate) => [candidate.name, candidate.detail, candidate.source])).toEqual([
    ["lab", "alice@lab-pc.tail.ts.net", "ssh_config"], ["after", null, "ssh_config"],
  ]);
});

it("reads the hosts of the files an Include names, in their place", async () => {
  const dir = sshDir({
    config: "Host first\n  HostName one.example\nInclude conf.d/*\nHost last\n",
    "conf.d/b": "Host from-b\n",
    "conf.d/a": "Host from-a\n  User a\n",
  });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => null });
  expect(candidates.map((candidate) => [candidate.name, candidate.detail])).toEqual([
    ["first", "one.example"], ["from-a", "a@from-a"], ["from-b", null], ["last", null],
  ]);
  expect(candidates.every((candidate) => candidate.source === "ssh_config" && candidate.destination === candidate.name)).toBe(true);
});

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

it("lists 200 PCs at most, Tailscale PCs included", async () => {
  const dir = sshDir({ config: Array.from({ length: 200 }, (_, index) => `Host h${index}`).join("\n") });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => status(["extra"]), resolve: async () => [] });
  expect(candidates).toHaveLength(200);
  expect(candidates.some((candidate) => candidate.source === "tailscale")).toBe(false);
});

it("adds the Tailscale PCs no config host already names, and names the Tailscale PC a config host is", async () => {
  const dir = sshDir({ config: "Host lab\n  HostName lab-pc.tail.ts.net\nHost eamac\nHost build\n  HostName build.example\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => status(["lab-pc", "eamac", "winvm"]), resolve: async () => [] });
  expect(candidates).toEqual([
    { name: "lab", destination: "lab", detail: "lab-pc.tail.ts.net", source: "ssh_config", tailnet: "lab-pc.tail.ts.net" },
    { name: "eamac", destination: "eamac", detail: null, source: "ssh_config", tailnet: "eamac.tail.ts.net" },
    { name: "build", destination: "build", detail: "build.example", source: "ssh_config" },
    { name: "winvm", destination: "winvm.tail.ts.net", detail: "winvm.tail.ts.net", source: "tailscale", tailnet: "winvm.tail.ts.net" },
  ]);
});

it("takes a config host's HostName over its alias: a stale alias naming one Tailscale PC while it reaches another claims the one it reaches", async () => {
  // the owner's Windows PC: `home-server` kept from before a rename, its HostName now old-desktop's Tailscale address
  const dir = sshDir({ config: "Host home-server\n  HostName 100.123.228.51\n" });
  const tailnet = JSON.stringify({
    BackendState: "Running",
    Self: { DNSName: "home-window.tail.ts.net.", UserID: 1 },
    Peer: {
      a: { DNSName: "home-server.tail.ts.net.", UserID: 1, Online: true, OS: "linux", TailscaleIPs: ["100.106.153.26", "fd7a:115c:a1e0::bc30:991b"] },
      b: { DNSName: "old-desktop.tail.ts.net.", UserID: 1, Online: true, OS: "linux", TailscaleIPs: ["100.123.228.51"] },
    },
  });
  expect(await sshCandidates({ sshDir: dir, readStatus: async () => tailnet })).toEqual([
    { name: "home-server", destination: "home-server", detail: "100.123.228.51", source: "ssh_config", tailnet: "old-desktop.tail.ts.net" },
    { name: "home-server", destination: "home-server.tail.ts.net", detail: "home-server.tail.ts.net", source: "tailscale", tailnet: "home-server.tail.ts.net" },
  ]);
});

it("takes the HostName ssh would use: later matching blocks after the alias's own, earlier ones first, `%h` as the alias", async () => {
  expect(await sshConfigHosts([
    "Host box", "  User me", "Host lab", "  HostName lab.example", "Host *.wild", "Host *", "  HostName 100.64.0.2",
  ].join("\n"))).toEqual([
    { alias: "box", hostname: "100.64.0.2", user: "me" },
    { alias: "lab", hostname: "lab.example", user: null },
  ]);
  expect(await sshConfigHosts("HostName first.example\nHost a b !b\nHost *\n  HostName %h.lan\nHost c\n")).toEqual([
    { alias: "a", hostname: "first.example", user: null }, { alias: "c", hostname: "first.example", user: null },
  ]);
  expect(await sshConfigHosts("Host !x *\n  HostName %h.lan\nHost box\n  HostName own.example\nHost x\n")).toEqual([
    { alias: "box", hostname: "box.lan", user: null }, { alias: "x", hostname: null, user: null },
  ]);
});

/** a tailnet of `box` at 100.64.0.1 and `other` at 100.64.0.2 and an IPv6 address */
const twoPeers = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "self.tail.ts.net.", UserID: 1 },
  Peer: {
    a: { DNSName: "box.tail.ts.net.", UserID: 1, Online: true, OS: "linux", TailscaleIPs: ["100.64.0.1"] },
    b: { DNSName: "other.tail.ts.net.", UserID: 1, Online: true, OS: "linux", TailscaleIPs: ["100.64.0.2", "fd7a:115c:a1e0::2"] },
  },
});
const resolver = (table: Record<string, string[]>) => async (host: string): Promise<string[]> => table[host] ?? [];

it("claims the Tailscale PC a config host's name resolves to, not the one it is spelled like", async () => {
  const dir = sshDir({ config: "Host box\nHost lab\n  HostName lab.lan\nHost far\n  HostName far.lan\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => twoPeers,
    resolve: resolver({ box: ["100.64.0.2"], "lab.lan": ["fd7a:115c:a1e0:0:0:0:0:2"], "far.lan": ["192.168.1.9"] }) });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([
    ["box", "other.tail.ts.net"], ["lab", "other.tail.ts.net"], ["far", undefined], ["box", "box.tail.ts.net"],
  ]);
});

it("matches an equivalent spelling of a Tailscale address without looking it up, and never across zone ids", async () => {
  const dir = sshDir({ config: "Host six\n  HostName FD7A:115C:A1E0:0:0:0:0:2\nHost mapped\n  HostName ::ffff:100.64.0.1\nHost zoned\n  HostName fe80::1%eth0\n" });
  const tailnet = JSON.stringify({ BackendState: "Running", Self: { DNSName: "self.tail.ts.net.", UserID: 1 }, Peer: {
    a: { DNSName: "box.tail.ts.net.", UserID: 1, Online: true, OS: "linux", TailscaleIPs: ["100.64.0.1"] },
    b: { DNSName: "other.tail.ts.net.", UserID: 1, Online: true, OS: "linux", TailscaleIPs: ["fd7a:115c:a1e0::2"] },
    c: { DNSName: "link.tail.ts.net.", UserID: 1, Online: true, OS: "linux", TailscaleIPs: ["fe80::1%eth1"] },
  } });
  const looked: string[] = [];
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => tailnet, resolve: async (host) => { looked.push(host); return []; } });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([
    ["six", "other.tail.ts.net"], ["mapped", "box.tail.ts.net"], ["zoned", undefined], ["link", "link.tail.ts.net"],
  ]);
  expect(looked).toEqual([]);
});

it("claims a PC only when every address a name resolves to is that PC's, whatever the order of answers or PCs", async () => {
  const dir = sshDir({ config: "Host mixed\nHost swapped\nHost half\nHost both\n" });
  const resolve = resolver({ mixed: ["100.64.0.1", "100.64.0.2"], swapped: ["100.64.0.2", "100.64.0.1"], half: ["100.64.0.2", "192.168.1.9"], both: ["fd7a:115c:a1e0::2", "100.64.0.2"] });
  const reversed = JSON.stringify({ ...JSON.parse(twoPeers), Peer: { b: JSON.parse(twoPeers).Peer.b, a: JSON.parse(twoPeers).Peer.a } });
  for (const tailnet of [twoPeers, reversed]) {
    const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => tailnet, resolve });
    expect(candidates.filter((candidate) => candidate.source === "ssh_config").map((candidate) => [candidate.name, candidate.tailnet])).toEqual([
      ["mixed", undefined], ["swapped", undefined], ["half", undefined], ["both", "other.tail.ts.net"],
    ]);
    expect(candidates.filter((candidate) => candidate.source === "tailscale").map((candidate) => candidate.name)).toEqual(["box"]);
  }
});

it("looks up a HostName as written, an absolute one with its trailing dot", async () => {
  const dir = sshDir({ config: "Host abs\n  HostName box.example.\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => twoPeers, resolve: resolver({ "box.example.": ["100.64.0.2"], "box.example": ["100.64.0.1"] }) });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["abs", "other.tail.ts.net"], ["box", "box.tail.ts.net"]]);
});

it("shares one listing between concurrent requests and keeps the lookups in flight bounded across listings", async () => {
  const dir = sshDir({ config: Array.from({ length: 40 }, (_, index) => `Host n${index}`).join("\n") });
  let statusReads = 0;
  let lookups = 0;
  const options = { sshDir: dir, readStatus: async () => { statusReads++; return twoPeers; }, resolve: () => { lookups++; return new Promise<string[]>(() => {}); }, resolveTimeoutMs: 0 };
  await Promise.all([sshCandidates(options), sshCandidates(options)]);
  expect(statusReads).toBe(1);
  const first = lookups;
  for (let round = 0; round < 4; round++) await sshCandidates(options);
  expect(statusReads).toBe(5);
  expect(first).toBeLessThanOrEqual(16);
  expect(lookups).toBe(first);
});

it("weighs each listed host against the HostName lines once, not every alias of a huge config", async () => {
  const config = [
    ...Array.from({ length: 400 }, (_, index) => `Host *.none${index}\n  HostName x`),
    ...Array.from({ length: 3000 }, (_, index) => `Host h${index}`),
  ].join("\n");
  const lowered = spyOn(String.prototype, "toLowerCase");
  try {
    const hosts = await sshConfigHosts(config);
    expect(hosts).toHaveLength(200);
    expect(lowered.mock.calls.length).toBeLessThan(200_000);
  } finally { lowered.mockRestore(); }
});

it("stops waiting on a lookup at the deadline and falls back to the name", async () => {
  const dir = sshDir({ config: "Host box\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => twoPeers, resolve: () => new Promise<string[]>(() => {}), resolveTimeoutMs: 0 });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
});

it("lists only the other source when one is missing", async () => {
  const empty = sshDir({});
  expect(await sshCandidates({ sshDir: empty, readStatus: async () => null })).toEqual([]);
  expect((await sshCandidates({ sshDir: empty, readStatus: async () => status(["box"]) })).map((candidate) => candidate.destination)).toEqual(["box.tail.ts.net"]);
});
