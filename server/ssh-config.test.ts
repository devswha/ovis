import { expect, it, spyOn } from "bun:test";

import { sshConfigHosts } from "./ssh-config.ts";

it("lists the hosts a config names with the first HostName and User that apply to each, leaving out patterns and Match", async () => {
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
    { alias: "nuc12", hostname: "100.127.218.1", user: "everyone" },
    { alias: "nuc", hostname: "100.127.218.1", user: "everyone" },
    { alias: "github.com", hostname: null, user: "everyone" },
    { alias: "quoted", hostname: "q.example", user: "everyone" },
    { alias: "keep", hostname: null, user: "everyone" },
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

it("applies a Match block as ssh does, for the conditions it can weigh offline", async () => {
  expect(await sshConfigHosts("Host alias\nMatch host alias\n  HostName 100.64.0.2\n  AddressFamily inet6\nHost *\n  HostName 100.64.0.1\n  AddressFamily inet\n"))
    .toEqual([{ alias: "alias", hostname: "100.64.0.2", user: null, addressFamily: "inet6" }]);
  expect(await sshConfigHosts([
    "Host b", "  HostName b.lan", "Host c", "  User root", "Host b c d f",
    "Match host B.LAN", "  AddressFamily inet", "Match user root", "  HostName root.lan",
    "Match localuser me !originalhost f", "  HostName me.lan", "Match all", "  AddressFamily inet6", "Match originalhost d", "  User from-match",
  ].join("\n"), async () => [], "me")).toEqual([
    { alias: "b", hostname: "b.lan", user: null, addressFamily: "inet" },
    { alias: "c", hostname: "root.lan", user: "root", addressFamily: "inet6" },
    { alias: "d", hostname: "me.lan", user: "from-match", addressFamily: "inet6" },
    { alias: "f", hostname: null, user: null, addressFamily: "inet6" },
  ]);
});

it("matches a long pattern against a long alias in linear time", async () => {
  const started = performance.now();
  const hosts = await sshConfigHosts(`Host ${"a".repeat(50_000)}c !*${"a".repeat(50_000)}b\n`);
  expect(performance.now() - started).toBeLessThan(250);
  expect(hosts).toHaveLength(1);
});

it("leaves a `?` pattern too costly to match unknown, at a cost bounded by its length, so its host claims nothing", async () => {
  const alias = "a".repeat(50_000);
  const reads = spyOn(String.prototype, "charCodeAt");
  try {
    const hosts = await sshConfigHosts(`Host ${alias} !*${"a".repeat(25_000)}?b*\n`);
    expect(hosts).toEqual([{ alias, hostname: null, user: null, undetermined: true }]);
    expect(reads.mock.calls.length).toBeLessThan(3_000_000);
  } finally { reads.mockRestore(); }
});

it("takes the options the final pass a `Match final` line asks for adds, and none past a canonical name", async () => {
  expect(await sshConfigHosts("Host box\nMatch final host 100.64.0.1\n  ProxyJump bastion\nHost *\n  HostName 100.64.0.1\n"))
    .toEqual([{ alias: "box", hostname: "100.64.0.1", user: null, proxied: true }]);
  expect(await sshConfigHosts("Host box\nMatch final originalhost none\nMatch canonical user admin\n  ProxyJump bastion\nHost *\n  HostName 100.64.0.1\n  User admin\n"))
    .toEqual([{ alias: "box", hostname: "100.64.0.1", user: "admin", proxied: true }]);
  expect(await sshConfigHosts("Host box\nMatch !final canonical\nMatch canonical\n  ProxyJump bastion\n")).toEqual([{ alias: "box", hostname: null, user: null }]);
  expect(await sshConfigHosts("Host box\n  HostName lab.example\nMatch final\nHost *.example\n  ProxyJump bastion\n"))
    .toEqual([{ alias: "box", hostname: "lab.example", user: null, proxied: true }]);
  expect(await sshConfigHosts("Host box\n  CanonicalizeHostname yes\n  HostName 100.64.0.1\n"))
    .toEqual([{ alias: "box", hostname: "100.64.0.1", user: null, undetermined: true }]);
});

it("claims nothing for a host an Include left unread may set, whether too deep or unreadable", async () => {
  const config = "Include more\nHost box\n  HostName 100.64.0.1\n";
  for (const include of [async () => ["Include more\n"], async () => [null]]) {
    expect(await sshConfigHosts(config, include)).toEqual([{ alias: "box", hostname: null, user: null, undetermined: true }]);
  }
});

it("takes the final pass a `Match final` in an Include asks for, even when the Include's block does not apply, as ssh does", async () => {
  const config = "Host other\n  Include inc\nHost box\n  HostName lab.example\nHost *.example\n  ProxyJump bastion\n";
  expect(await sshConfigHosts(config, async () => ["Match final\n"])).toEqual([
    { alias: "other", hostname: null, user: null },
    { alias: "box", hostname: "lab.example", user: null, proxied: true },
  ]);
});

it("claims nothing for a host whose final pass an unread Include may ask for, even when the Include's block does not apply", async () => {
  const config = "Host other\n  Include inc\nHost box\n  HostName lab.example\nHost *.example\n  ProxyJump bastion\n";
  expect(await sshConfigHosts(config, async () => [null])).toEqual([
    { alias: "other", hostname: null, user: null, undetermined: true },
    { alias: "box", hostname: "lab.example", user: null, undetermined: true },
  ]);
});

it("stops a line at a word that starts a comment", async () => {
  expect(await sshConfigHosts("Host lab # work machine\n  HostName lab.example # the desk\n")).toEqual([{ alias: "lab", hostname: "lab.example", user: null }]);
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

it("groups the blocks of a repeated alias in work linear in the config, not one copy of the group per repeat", async () => {
  const steps = spyOn(Object.getPrototypeOf([][Symbol.iterator]()), "next");
  try {
    const hosts = await sshConfigHosts("Host x\n".repeat(4000));
    expect(hosts).toEqual([{ alias: "x", hostname: null, user: null }]);
    expect(steps.mock.calls.length).toBeLessThan(100_000);
  } finally { steps.mockRestore(); }
});
