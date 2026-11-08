import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
