import { expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type SetupJob, type SetupRequest } from "../shared/machines.ts";
import { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { posixHost, windowsHost } from "./remote-host.ts";
import { SshConnection } from "./ssh.ts";
import { readProcessBirth } from "./process-owner.ts";

// quiet: the live server cannot prove itself at first (no answer, an HTTP error); open: once chosen, it no longer can
const quiet = ["unanswered", "server error"], open = ["wrong token", "redirect", "server error later", "server error after proof"];
it.each(["connect", "default bridge", "birthless", "unanswered", "server error", "server error later", "server error after proof", "older peer", "gone", "symlink", "reused pid", "changed port", "stopped after proof", "wrong token", "wrong pid", "managed", "wrong runtime", "redirect"])("chooses the PC's own core server: %s", async (outcome) => {
  const dir = mkdtempSync(join(tmpdir(), "machine-core-choice-"));
  const id = "12345678-1234-1234-1234-123456789abc";
  const socket = "/home/fixture/.config/ovis/hc-adapter.sock";
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "fixture", enabled: false, target: { destination: "fixture-only" } }]));
  const birth = readProcessBirth(process.pid);
  if (birth.state !== "identified") throw new Error("Test process birth unavailable");
  // birthless: an older server's registration, which recorded no process birth
  const descriptor = { socket_path: socket, pid: process.pid, ...(outcome === "birthless" ? {} : { birth: birth.birth }), port: 12345, token: "a".repeat(64), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: false };
  // default bridge: this app's bridge already serves the PC's default herdr socket, as on a saved PC that reconnects
  const bridge = { socket_path: join(dir, ".config/herdr/herdr.sock"), pid: process.pid, port: 23456, token: "b".repeat(64), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: true };
  const listedHere = outcome === "default bridge" ? [bridge, descriptor] : [descriptor];
  const registry = join(dir, ".config/herdr-web-ui/bridges");
  mkdirSync(registry, { recursive: true });
  const registration = join(registry, createHash("sha256").update(socket).digest("hex") + ".json");
  writeFileSync(registration, JSON.stringify(descriptor), { mode: 0o600 });
  const herdrDir = join(dir, ".config/herdr/sessions/work");
  mkdirSync(herdrDir, { recursive: true });
  const sessions = [{ socket_path: join(herdrDir, "herdr.sock"), session: "work", label: "work" }];
  // no TUI herdr runs beside a quiet core server, so nothing else could be offered
  const herdr = quiet.includes(outcome) ? undefined : Bun.listen({ unix: sessions[0]!.socket_path, socket: { data() {} } });
  if (!herdr) sessions.length = 0;
  const runtimeDir = join(dir, "runtime");
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });
  symlinkSync(process.execPath, join(runtimeDir, "bin/bun"));
  symlinkSync(import.meta.dir, join(runtimeDir, "server"));
  const relays: ReturnType<typeof Bun.serve>[] = [];
  let selected = false, starts = 0, answering = !quiet.includes(outcome);
  const commands: string[] = [];
  const realFetch = globalThis.fetch;
  const mocks = [
    // a live server that cannot answer right now: its identity request times out
    spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => !answering && outcome === "unanswered" && String(input).includes("/api/bridge")
      ? Promise.reject(new DOMException("Fixture bridge answer timed out", "TimeoutError")) : realFetch(input, init), { preconnect: realFetch.preconnect })),
    spyOn(SshConnection.prototype, "start").mockResolvedValue(undefined),
    spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
    spyOn(SshConnection.prototype, "run").mockImplementation(async (command) => {
      commands.push(command);
      const shell = Bun.spawn(["sh", "-c", command], { env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(shell.stdout).text(), new Response(shell.stderr).text(), shell.exited]);
      if (code !== 0) throw new Error(err);
      return out;
    }),
    spyOn(posixHost, "herdrVersion").mockResolvedValue("herdr 0.9.0"),
    spyOn(posixHost, "inspect").mockResolvedValue({ platform: "linux-x64", home: dir, herdrPath: "/fixture/herdr", expectedSocket: join(dir, ".config/herdr/herdr.sock"), bundleReady: true, bundleOlder: false, descriptors: listedHere, runtimeDir, registryDir: registry }),
    spyOn(posixHost, "descriptors").mockResolvedValue(listedHere),
    spyOn(posixHost, "alive").mockImplementation(async () => !selected || outcome !== "stopped after proof"),
    spyOn(posixHost, "installBundle").mockResolvedValue(undefined),
    spyOn(posixHost, "start").mockImplementation(async () => { starts++; throw new Error("must not start herdr"); }),
    spyOn(SshConnection.prototype, "forward").mockImplementation(async (port, remotePort) => {
      const served = remotePort === bridge.port && outcome === "default bridge" ? bridge : descriptor;
      expect(remotePort).toBe(served.port);
      relays.push(Bun.serve({ port, hostname: "127.0.0.1", fetch(request, server) {
        expect(request.headers.get("authorization")).toBe(`Bearer ${served.token}`);
        const path = new URL(request.url).pathname;
        if (path === "/api/bridge" && served === bridge) return Response.json({ ...bridge, socket_id: "fixture:tui", herdr: { protocol: 22, version: "0.9.0", runtime: "herdr" } });
        if (path === "/api/bridge") {
          // the server cannot reach its core adapter right now: every identity request, or (after proof) the one after discovery
          const discovering = new URL(request.url).searchParams.get("discover") === "herdr";
          if ((!answering && outcome === "server error") || (selected && outcome === "server error later") || (selected && outcome === "server error after proof" && !discovering)) {
            return Response.json({ error: { code: "herdr_unavailable", message: "herdr-core is not answering" } }, { status: 500 });
          }
          if (selected && outcome === "wrong token") return new Response(null, { status: 401 });
          if (selected && outcome === "redirect") return Response.redirect("http://127.0.0.1:1/");
          return Response.json({ ...descriptor, pid: selected && outcome === "wrong pid" ? process.pid + 1 : process.pid, managed_remote: selected && outcome === "managed", socket_id: "fixture:core", herdr: { protocol: 22, version: "0.1.17", runtime: selected && outcome === "wrong runtime" ? "herdr" : "herdr-core" }, ...(outcome === "older peer" ? {} : { found_herdr_sessions: sessions }) });
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
    if (outcome === "default bridge") {
      // reconnects to its live bridge on its own, as before: no choice it did not ask for, nothing started, no retry
      const reconnect = await run({ destination: "fixture-only" });
      expect(reconnect).toMatchObject({ phase: "connected", runtime: "herdr" });
      expect(reconnect.action_required ?? null).toBeNull();
      expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ state: "connected", runtime: "herdr", action_required: null });
      expect(starts).toBe(0);
      return;
    }
    const offer = await run({ destination: "fixture-only" });
    expect(offer).toMatchObject({ phase: "failed", action_required: "choose_herdr", found_herdr_sessions: sessions, found_ovis: [{ socket_path: socket, runtime: "herdr-core" }] });
    expect(starts).toBe(0);
    if (quiet.includes(outcome)) {
      // a plain choice: neither the tunnel's address nor a reason to start Ovis on that PC (it runs)
      expect(offer.error).not.toContain("127.0.0.1");
      expect(offer.error).not.toBe("Start Ovis on that PC, or start a new herdr here");
      const waiting = await run({ destination: "fixture-only", own_ovis: socket });
      expect(waiting).toMatchObject({ phase: "failed", action_required: "choose_herdr", error: offer.error, found_ovis: [{ socket_path: socket, runtime: "herdr-core" }] });
      expect(starts).toBe(0);
      expect(manager.endpoint(id)).toBeUndefined();
      expect(retries).not.toHaveBeenCalled();
      answering = true;
    }
    expect((await run({ destination: "fixture-only", own_ovis: socket })).phase).toBe("connected");
    retries.mockClear();
    selected = true;
    if (outcome === "gone" || outcome === "symlink") rmSync(registration);
    if (outcome === "symlink") { writeFileSync(join(dir, "outside.json"), JSON.stringify(descriptor)); symlinkSync(join(dir, "outside.json"), registration); }
    if (outcome === "reused pid") descriptor.birth = { ...birth.birth, value: "not-this-process" };
    if (outcome === "changed port") writeFileSync(registration, JSON.stringify({ ...descriptor, port: 12346 }));
    const chosen = await run({ destination: "fixture-only", own_ovis: socket });
    const connects = ["connect", "birthless", "older peer", ...quiet].includes(outcome);
    expect(chosen.phase).toBe(connects ? "connected" : "failed");
    expect(starts).toBe(0);
    // the registration's token goes only in the tunnel's HTTP request, never in a command on that PC
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command).not.toContain(descriptor.token);
    if (connects) {
      expect(chosen.runtime).toBe("herdr-core");
      expect(manager.list().find((pc) => pc.id === chosen.machine_id)).toMatchObject({ runtime: "herdr-core", target: { own_ovis: socket }, snapshot: { workspaces: [{ id: "core-work" }] } });
    } else if (open.includes(outcome)) {
      // owned and live, its identity not established: still offered, never dropped, nothing started in its place
      expect(chosen).toMatchObject({ action_required: "choose_herdr", found_herdr_sessions: sessions, found_ovis: [{ socket_path: socket, runtime: "herdr-core" }] });
      expect(chosen.error).not.toBe("Start Ovis on that PC, or start a new herdr here");
      expect(manager.endpoint(chosen.machine_id!)).toBeUndefined();
      expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ action_required: "choose_herdr", found_ovis: [{ socket_path: socket, runtime: "herdr-core" }] });
      expect(retries).not.toHaveBeenCalled();
    } else {
      expect(chosen).toMatchObject({ action_required: "choose_herdr", error: "Start Ovis on that PC, or start a new herdr here", found_herdr_sessions: sessions });
      expect(manager.endpoint(chosen.machine_id!)).toBeUndefined();
      expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ action_required: "choose_herdr", error: "Start Ovis on that PC, or start a new herdr here", found_herdr_sessions: sessions });
      expect(retries).not.toHaveBeenCalled();
    }
  } finally {
    manager.stop(); retries.mockRestore(); mocks.forEach((mock) => mock.mockRestore()); relays.forEach((relay) => relay.stop(true)); herdr?.stop(true); rmSync(dir, { recursive: true, force: true });
  }
});

it("asks for a new choice instead of retrying when a saved Windows PC is set to use its own Ovis server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "machine-core-windows-"));
  const id = "12345678-1234-1234-1234-123456789abd";
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "fixture", enabled: false, target: { destination: "fixture-only", own_ovis: "/home/fixture/.config/ovis/hc-adapter.sock" } }]));
  const mocks = [
    spyOn(SshConnection.prototype, "start").mockResolvedValue(undefined),
    spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
    spyOn(SshConnection.prototype, "run").mockRejectedValue(new Error("no command is expected on that PC")),
    spyOn(posixHost, "inspect").mockRejectedValue(new Error("not a POSIX shell")),
    spyOn(windowsHost, "inspect").mockResolvedValue({ platform: "win32-x64", home: "C:\\Users\\fixture", herdrPath: "", expectedSocket: "\\\\.\\pipe\\herdr", bundleReady: true, bundleOlder: false, descriptors: [], runtimeDir: "C:\\runtime", registryDir: "C:\\registry" }),
    spyOn(windowsHost, "start").mockImplementation(async () => { throw new Error("must not start herdr"); }),
  ];
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("isolated"); });
  // the PC's own reconnect ends in a retry scheduled (the bug) or a decision for the user, whichever comes first
  const settled = Promise.withResolvers<"retry" | "decision">();
  const retries = spyOn(MachineManager.prototype as unknown as { retryLater(runtime: unknown): void }, "retryLater").mockImplementation(() => settled.resolve("retry"));
  const off = manager.subscribe(() => { if (manager.list().find((pc) => pc.id === id)?.state === "error") settled.resolve("decision"); });
  const timeout = setTimeout(() => settled.reject(new Error("the reconnect did not settle")), 5000);
  try {
    manager.patch(id, { enabled: true });
    expect(await settled.promise).toBe("decision");
    // a decision for the user, as any MachineActionRequired: the PC waits for it instead of reconnecting
    expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ state: "error", action_required: "setup" });
    expect(retries).not.toHaveBeenCalled();
  } finally {
    clearTimeout(timeout); off(); manager.stop(); retries.mockRestore(); mocks.forEach((mock) => mock.mockRestore()); rmSync(dir, { recursive: true, force: true });
  }
});
