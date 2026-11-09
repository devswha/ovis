import { expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type SetupJob, type SetupRequest } from "../shared/machines.ts";
import { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { posixHost } from "./remote-host.ts";
import { SshConnection } from "./ssh.ts";
import { readProcessBirth } from "./process-owner.ts";

it.each(["connect", "gone", "symlink", "reused pid", "changed port", "stopped after proof", "wrong token", "wrong pid", "managed", "wrong runtime", "redirect"])("chooses the PC's own core server: %s", async (outcome) => {
  const dir = mkdtempSync(join(tmpdir(), "machine-core-choice-"));
  const id = "12345678-1234-1234-1234-123456789abc";
  const socket = "/home/fixture/.config/ovis/hc-adapter.sock";
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "fixture", enabled: false, target: { destination: "fixture-only" } }]));
  const birth = readProcessBirth(process.pid);
  if (birth.state !== "identified") throw new Error("Test process birth unavailable");
  const descriptor = { socket_path: socket, pid: process.pid, birth: birth.birth, port: 12345, token: "a".repeat(64), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: false };
  const registry = join(dir, ".config/herdr-web-ui/bridges");
  mkdirSync(registry, { recursive: true });
  const registration = join(registry, createHash("sha256").update(socket).digest("hex") + ".json");
  writeFileSync(registration, JSON.stringify(descriptor), { mode: 0o600 });
  const herdrDir = join(dir, ".config/herdr/sessions/work");
  mkdirSync(herdrDir, { recursive: true });
  const sessions = [{ socket_path: join(herdrDir, "herdr.sock"), session: "work", label: "work" }];
  const herdr = Bun.listen({ unix: sessions[0]!.socket_path, socket: { data() {} } });
  const runtimeDir = join(dir, "runtime");
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });
  symlinkSync(process.execPath, join(runtimeDir, "bin/bun"));
  symlinkSync(import.meta.dir, join(runtimeDir, "server"));
  const relays: ReturnType<typeof Bun.serve>[] = [];
  let selected = false, starts = 0;
  const mocks = [
    spyOn(SshConnection.prototype, "start").mockResolvedValue(undefined),
    spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
    spyOn(SshConnection.prototype, "run").mockImplementation(async (command) => {
      const shell = Bun.spawn(["sh", "-c", command], { env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(shell.stdout).text(), new Response(shell.stderr).text(), shell.exited]);
      if (code !== 0) throw new Error(err);
      return out;
    }),
    spyOn(posixHost, "inspect").mockResolvedValue({ platform: "linux-x64", home: dir, herdrPath: "", expectedSocket: join(dir, ".config/herdr/herdr.sock"), bundleReady: true, bundleOlder: false, descriptors: [descriptor], runtimeDir, registryDir: registry }),
    spyOn(posixHost, "descriptors").mockResolvedValue([descriptor]),
    spyOn(posixHost, "alive").mockImplementation(async () => !selected || outcome !== "stopped after proof"),
    spyOn(posixHost, "installBundle").mockResolvedValue(undefined),
    spyOn(posixHost, "start").mockImplementation(async () => { starts++; throw new Error("must not start herdr"); }),
    spyOn(SshConnection.prototype, "forward").mockImplementation(async (port, remotePort) => {
      expect(remotePort).toBe(descriptor.port);
      relays.push(Bun.serve({ port, hostname: "127.0.0.1", fetch(request, server) {
        expect(request.headers.get("authorization")).toBe(`Bearer ${descriptor.token}`);
        const path = new URL(request.url).pathname;
        if (path === "/api/bridge") {
          if (selected && outcome === "wrong token") return new Response(null, { status: 401 });
          if (selected && outcome === "redirect") return Response.redirect("http://127.0.0.1:1/");
          return Response.json({ ...descriptor, pid: selected && outcome === "wrong pid" ? process.pid + 1 : process.pid, managed_remote: selected && outcome === "managed", socket_id: "fixture:core", herdr: { protocol: 22, version: "0.1.17", runtime: selected && outcome === "wrong runtime" ? "herdr" : "herdr-core" }, found_herdr_sessions: sessions });
        }
        if (path === "/api/session") return Response.json({ snapshot: { panes: [], workspaces: [{ id: "core-work", name: "Existing core work" }] } });
        if (path === "/ws" && server.upgrade(request, { data: undefined })) return;
        return new Response(null, { status: 404 });
      }, websocket: { message() {} } }));
    }),
  ];
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("isolated"); });
  const retries = spyOn(MachineManager.prototype as unknown as { retryLater(runtime: unknown): void }, "retryLater");
  const run = (request: SetupRequest) => new Promise<SetupJob>((resolve, reject) => {
    let job: SetupJob | undefined;
    const timeout = setTimeout(() => { off(); reject(new Error("setup did not settle")); }, 5000);
    const off = manager.subscribe(() => { if (job && ["failed", "connected"].includes(job.phase)) { clearTimeout(timeout); off(); resolve(job); } });
    job = manager.setup({ ...request, machine_id: id, update_remote: true }, { auto: true });
  });
  try {
    const offer = await run({ destination: "fixture-only" });
    expect(offer).toMatchObject({ phase: "failed", action_required: "choose_herdr", found_herdr_sessions: sessions, found_ovis: [{ socket_path: socket, runtime: "herdr-core" }] });
    expect((await run({ destination: "fixture-only", own_ovis: socket })).phase).toBe("connected");
    retries.mockClear();
    selected = true;
    if (outcome === "gone" || outcome === "symlink") rmSync(registration);
    if (outcome === "symlink") { writeFileSync(join(dir, "outside.json"), JSON.stringify(descriptor)); symlinkSync(join(dir, "outside.json"), registration); }
    if (outcome === "reused pid") descriptor.birth = { ...birth.birth, value: "not-this-process" };
    if (outcome === "changed port") writeFileSync(registration, JSON.stringify({ ...descriptor, port: 12346 }));
    const chosen = await run({ destination: "fixture-only", own_ovis: socket });
    expect(chosen.phase).toBe(outcome === "connect" ? "connected" : "failed");
    expect(starts).toBe(0);
    if (outcome === "connect") {
      expect(chosen.runtime).toBe("herdr-core");
      expect(manager.list().find((pc) => pc.id === chosen.machine_id)).toMatchObject({ runtime: "herdr-core", target: { own_ovis: socket }, snapshot: { workspaces: [{ id: "core-work" }] } });
    } else {
      expect(chosen).toMatchObject({ action_required: "choose_herdr", error: "Start Ovis on that PC, or start a new herdr here", found_herdr_sessions: sessions });
      expect(manager.endpoint(chosen.machine_id!)).toBeUndefined();
      expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ action_required: "choose_herdr", error: "Start Ovis on that PC, or start a new herdr here", found_herdr_sessions: sessions });
      expect(retries).not.toHaveBeenCalled();
    }
  } finally {
    manager.stop(); retries.mockRestore(); mocks.forEach((mock) => mock.mockRestore()); relays.forEach((relay) => relay.stop(true)); herdr.stop(true); rmSync(dir, { recursive: true, force: true });
  }
});
