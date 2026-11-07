import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CompletionTracker } from "./completion.ts";
import { createServer } from "./index.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
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
    "Host nuc",
    "  HostName later.example",
  ].join("\n"));
  expect(hosts).toEqual([
    { alias: "nuc12", hostname: "100.127.218.1", user: "rise" },
    { alias: "nuc", hostname: "100.127.218.1", user: "rise" },
    { alias: "github.com", hostname: null, user: "git" },
    { alias: "quoted", hostname: "q.example", user: null },
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

it("adds the Tailscale PCs no config host already names, by their MagicDNS name", async () => {
  const dir = sshDir({ config: "Host lab\n  HostName lab-pc.tail.ts.net\nHost eamac\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => status(["lab-pc", "eamac", "winvm"]) });
  expect(candidates).toEqual([
    { name: "lab", destination: "lab", detail: "lab-pc.tail.ts.net", source: "ssh_config" },
    { name: "eamac", destination: "eamac", detail: null, source: "ssh_config" },
    { name: "winvm", destination: "winvm.tail.ts.net", detail: "winvm.tail.ts.net", source: "tailscale" },
  ]);
});

it("lists only the other source when one is missing", async () => {
  const empty = sshDir({});
  expect(await sshCandidates({ sshDir: empty, readStatus: async () => null })).toEqual([]);
  expect((await sshCandidates({ sshDir: empty, readStatus: async () => status(["box"]) })).map((candidate) => candidate.destination)).toEqual(["box.tail.ts.net"]);
});

it("answers the owner's window with the list, and refuses an open LAN window and a watching device", async () => {
  const dir = sshDir({ config: "Host nuc12\n  HostName 100.127.218.1\n  User rise\nHost *\n" });
  const state = sshDir({});
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: state, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false,
    sshCandidates: { sshDir: dir, readStatus: async () => status(["winvm"]) } });
  cleanup.push(() => { void server.stop(); });
  const base = `http://127.0.0.1:${server.port}`;
  const owner = await fetch(`${base}/api/machines/ssh-candidates`, { headers: { origin: base } });
  expect(owner.status).toBe(200);
  expect((await owner.json() as { pcs: { destination: string }[] }).pcs.map((pc) => pc.destination)).toEqual(["nuc12", "winvm.tail.ts.net"]);
  const fromLan = await fetch(`${base}/api/machines/ssh-candidates`, { headers: { origin: base, "x-forwarded-for": "192.168.1.5" } });
  expect(fromLan.status).toBe(403);
  expect((await fromLan.json() as { error: { code: string } }).error.code).toBe("owner_only");

  let read = 0;
  const manager = new MachineManager(state, {} as PushService, {} as CompletionTracker, async () => { throw new Error("local offline"); },
    { sshCandidates: { sshDir: dir, readStatus: async () => { read++; return null; } } });
  const watching = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/ssh-candidates"), manager, undefined, undefined, true);
  expect(watching.status).toBe(403);
  expect(read).toBe(0);
  manager.stop();
});
