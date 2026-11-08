import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type SetupJob, type SshTarget } from "../shared/machines.ts";
import { CompletionTracker } from "./completion.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { posixHost } from "./remote-host.ts";
import { SshConnection } from "./ssh.ts";

it("puts found sessions on the job and card, then remembers the chosen socket across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "machine-herdr-choice-"));
  const id = "12345678-1234-1234-1234-123456789abc";
  const socket = "/home/fixture/desktop/herdr/sessions/work/herdr.sock";
  const found = [{ socket_path: socket, session: "work", label: "work" }];
  const descriptor = { socket_path: socket, pid: 4242, port: 12345, token: "a".repeat(64), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: true };
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id, name: "fixture", enabled: false, target: { destination: "fixture-only" } }]));
  const relays: ReturnType<typeof Bun.serve>[] = [];
  const mocks = [
    spyOn(SshConnection.prototype, "start").mockResolvedValue(undefined),
    spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
    spyOn(posixHost, "inspect").mockImplementation(async (_ssh, _session, selected) => ({ platform: "linux-x64", home: "/home/fixture", herdrPath: "", expectedSocket: selected ?? "/home/fixture/.config/herdr/herdr.sock", bundleReady: true, bundleOlder: false, descriptors: selected ? [descriptor] : [], runtimeDir: "/runtime", registryDir: "/registry" })),
    spyOn(posixHost, "installBundle").mockResolvedValue(undefined),
    spyOn(posixHost, "start").mockResolvedValue(undefined),
    spyOn(posixHost, "descriptors").mockResolvedValue([]),
    spyOn(posixHost, "foundSessions").mockResolvedValue(found),
    spyOn(posixHost, "alive").mockResolvedValue(true),
    spyOn(SshConnection.prototype, "forward").mockImplementation(async (port) => {
      relays.push(Bun.serve({ port, hostname: "127.0.0.1", fetch(request, server) {
        const path = new URL(request.url).pathname;
        if (path === "/api/bridge") return Response.json({ ...descriptor, socket_id: "fixture:1", herdr: { protocol: 22, version: "0.9.3" } });
        if (path === "/api/session") return Response.json({ snapshot: { panes: [], workspaces: [] } });
        if (path === "/ws" && server.upgrade(request, { data: undefined })) return;
        return new Response("absent", { status: 404 });
      }, websocket: { message() {} } }));
    }),
  ];
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("isolated"); });
  const run = (target: SshTarget): Promise<SetupJob> => new Promise((resolve, reject) => {
    let job: SetupJob | undefined;
    const deadline = setTimeout(() => { off(); reject(new Error("setup did not finish")); }, 5000);
    const off = manager.subscribe(() => {
      if (!job || !["failed", "connected"].includes(job.phase)) return;
      clearTimeout(deadline); off(); resolve(job);
    });
    job = manager.setup({ ...target, machine_id: id, update_remote: true }, { auto: true });
  });
  try {
    const failed = await run({ destination: "fixture-only" });
    expect(failed).toMatchObject({ phase: "failed", action_required: "choose_herdr", found_herdr_sessions: found });
    expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ action_required: "choose_herdr", found_herdr_sessions: found });
    const target = { destination: "fixture-only", session: "work", herdr_socket: socket };
    expect(await run(target)).toMatchObject({ phase: "connected", target });
    expect(manager.list().find((pc) => pc.id === id)).toMatchObject({ target, action_required: null });
    expect(JSON.parse(readFileSync(join(dir, "machines.json"), "utf8"))[0].target).toEqual(target);
    manager.patch(id, { enabled: false });
    manager.stop();
    const restored = new MachineManager(dir, {} as PushService, new CompletionTracker(null), async () => { throw new Error("isolated"); });
    try { expect(restored.list().find((pc) => pc.id === id)?.target).toEqual(target); }
    finally { restored.stop(); }
  } finally {
    manager.stop();
    for (const mock of mocks) mock.mockRestore();
    for (const relay of relays) relay.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
