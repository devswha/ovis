import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverHerdrSessions } from "./herdr-discovery.ts";

const roots: string[] = [];
const listeners: ReturnType<typeof Bun.listen>[] = [];
afterEach(() => {
  for (const listener of listeners.splice(0)) listener.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "herdr-discovery-"));
  roots.push(home);
  const procRoot = join(home, "proc");
  mkdirSync(procRoot);
  return { home, procRoot, platform: "linux" as const, uid: process.getuid?.() ?? 0 };
}
function listening(socket: string) {
  mkdirSync(dirname(socket), { recursive: true });
  listeners.push(Bun.listen({ unix: socket, socket: { data() {} } }));
}

describe("running herdr discovery", () => {
  it.each([
    ["/home/u/.local/bin/herdr", [], undefined],
    ["/usr/local/bin/herdr", ["--session", "check-873df7"], "check-873df7"],
    ["/usr/local/bin/herdr-real", ["--session", "work"], "work"],
  ] as const)("finds server executable %s", async (binary, flags, session) => {
    const f = fixture();
    const xdg = join(f.home, "desktop");
    const socket = join(xdg, "herdr", ...(session ? ["sessions", session] : []), "herdr.sock");
    listening(socket);
    mkdirSync(join(f.procRoot, "100"));
    writeFileSync(join(f.procRoot, "100/cmdline"), [binary, ...flags, "server", ""].join("\0"));
    writeFileSync(join(f.procRoot, "100/environ"), `HOME=${f.home}\0XDG_CONFIG_HOME=${xdg}\0`);
    expect(await discoverHerdrSessions(f)).toEqual([{ socket_path: socket, ...(session ? { session } : {}), label: session ?? "Default session" }]);
    writeFileSync(join(f.procRoot, "100/cmdline"), [binary, ...flags, "terminal", "attach", "server", ""].join("\0"));
    expect(await discoverHerdrSessions(f)).toEqual([]);
  });

  it("finds a listening herdr socket of this account by /proc/net/unix, any program and any XDG root, only outside a sandbox", async () => {
    const f = fixture();
    // a desktop herdr under an XDG root outside HOME (its path holding a space), served by a program not named herdr: no
    // process line names it
    const outside = mkdtempSync(join(tmpdir(), "herdr discovery xdg-"));
    roots.push(outside);
    const socket = join(outside, "herdr/sessions/work/herdr.sock");
    listening(socket);
    mkdirSync(join(f.procRoot, "net"));
    writeFileSync(join(f.procRoot, "net/unix"), `Num       RefCount Protocol Flags    Type St Inode Path
0000000000000000: 00000002 00000000 00010000 0001 01 4242 ${socket}
0000000000000000: 00000002 00000000 00000000 0001 03 4243 ${join(outside, "other/herdr.sock")}
`);
    expect(await discoverHerdrSessions({ ...f, accountHome: f.home })).toEqual([{ socket_path: socket, session: "work", label: "work" }]);
    // a sandbox HOME never reaches it
    expect(await discoverHerdrSessions({ ...f, accountHome: "/home/someone-else" })).toEqual([]);
  });

  it("rejects sockets owned by another uid even in the inherited XDG root", async () => {
    const f = fixture();
    const xdg = join(f.home, "inherited-xdg");
    listening(join(xdg, "herdr/herdr.sock"));
    expect(await discoverHerdrSessions({ ...f, xdg, uid: f.uid + 1 })).toEqual([]);
  });

  it("rejects a symlink escaping HOME and the configured XDG root", async () => {
    const f = fixture(), outside = fixture();
    const socket = join(outside.home, "herdr/herdr.sock");
    listening(socket);
    const link = join(f.home, ".config/herdr/herdr.sock");
    mkdirSync(dirname(link), { recursive: true }); symlinkSync(socket, link);
    expect(await discoverHerdrSessions(f)).toEqual([]);
  });

  it("does not offer a permission-denied socket", async () => {
    const f = fixture();
    const socket = join(f.home, ".config/herdr/herdr.sock");
    listening(socket); chmodSync(socket, 0);
    try { expect(await discoverHerdrSessions(f)).toEqual([]); }
    finally { chmodSync(socket, 0o600); }
  });

  it("finds a desktop-only XDG root from this user's server process", async () => {
    const f = fixture();
    const xdg = join(f.home, "desktop");
    const socket = join(xdg, "herdr/sessions/work/herdr.sock");
    listening(socket);
    mkdirSync(join(f.procRoot, "100"));
    writeFileSync(join(f.procRoot, "100/cmdline"), "/usr/bin/herdr\0--session\0work\0server\0");
    writeFileSync(join(f.procRoot, "100/environ"), `HOME=${f.home}\0XDG_CONFIG_HOME=${xdg}\0`);
    expect(await discoverHerdrSessions(f)).toEqual([{ socket_path: socket, session: "work", label: "work" }]);
  });

  it("deduplicates live default and named sockets and ignores stale files", async () => {
    const f = fixture();
    const xdg = join(f.home, ".config");
    const socket = join(xdg, "herdr/herdr.sock");
    const named = join(xdg, "herdr/sessions/qa/herdr.sock");
    listening(socket); listening(named);
    mkdirSync(join(xdg, "herdr/sessions/stale"), { recursive: true });
    writeFileSync(join(xdg, "herdr/sessions/stale/herdr.sock"), "stale");
    expect(await discoverHerdrSessions({ ...f, xdg })).toEqual([
      { socket_path: socket, label: "Default session" },
      { socket_path: named, session: "qa", label: "qa" },
    ]);
  });

  it("ignores client processes and processes belonging to another uid", async () => {
    const f = fixture();
    const xdg = join(f.home, "desktop");
    listening(join(xdg, "herdr/herdr.sock"));
    mkdirSync(join(f.procRoot, "100"));
    writeFileSync(join(f.procRoot, "100/cmdline"), "/usr/bin/herdr\0status\0server\0");
    writeFileSync(join(f.procRoot, "100/status"), `Name:\therdr\nUid:\t${f.uid}\t${f.uid}\t${f.uid}\t${f.uid}\n`);
    writeFileSync(join(f.procRoot, "100/environ"), `HOME=${f.home}\0XDG_CONFIG_HOME=${xdg}\0`);
    expect(await discoverHerdrSessions(f)).toEqual([]);
    writeFileSync(join(f.procRoot, "100/cmdline"), "/usr/bin/herdr\0server\0");
    expect(await discoverHerdrSessions({ ...f, uid: f.uid + 1 })).toEqual([]);
  });
});
