import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine, PcInstallJob, RemoteOvis, SshTarget } from "../shared/machines.ts";
import type { CompletionTracker } from "./completion.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { SshConnection } from "./ssh.ts";

// The install routes and the one-job-per-PC rule on a manager with one saved SSH PC. SSH never connects: each
// connection waits until the test lets it in, refuses it, or it is closed. No PC, herdr or real state is touched.
const SAVED = "00000000-0000-4000-8000-0000000000aa";
type Runtime = { machine: Machine; installFix?: { mode: "replace" | "restart"; pid: number; target: SshTarget } };
type Internals = { machines: Map<string, Runtime>; reconnect(runtime: Runtime): Promise<void> };

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-install-routes-"));
  writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id: SAVED, name: "Lab", target: { destination: "me@lab.invalid" }, enabled: true }]));
  const reconnect = spyOn(MachineManager.prototype as unknown as Internals, "reconnect").mockImplementation(async () => {});
  const real = { start: SshConnection.prototype.start, close: SshConnection.prototype.close };
  /** the SSH connections waiting to be let in, by destination */
  const waiting = new Map<string, { refuse(words: string): void }>();
  SshConnection.prototype.start = function (this: SshConnection) {
    return new Promise<void>((_, reject) => {
      waiting.set(this.target.destination, { refuse: (words) => reject(new Error(words)) });
      (this as unknown as { refuse?: () => void }).refuse = () => reject(new Error("SSH connection closed"));
    });
  };
  SshConnection.prototype.close = function (this: SshConnection) { (this as unknown as { refuse?: () => void }).refuse?.(); };
  const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("isolated local offline"); });
  cleanups.push(() => { manager.stop(); Object.assign(SshConnection.prototype, real); reconnect.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
  const call = (path: string, method = "POST", body?: unknown, readOnly = false) => handleMachineRequest(new Request(`http://localhost:7317/api/machines/${path}`,
    { method, headers: { origin: "http://localhost:7317", "x-herdr-machine": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), manager, undefined, undefined, readOnly);
  const until = async (done: () => boolean) => { const deadline = Date.now() + 2000; while (!done()) { if (Date.now() > deadline) throw new Error("condition timed out"); await Bun.sleep(5); } };
  return { manager, internals: manager as unknown as Internals, waiting, call, until };
}

it("starts an install on a PC not added here, tells its job, refuses a watching device and an address already added", async () => {
  const { manager, waiting, call, until } = fixture();
  expect((await call("install", "POST", { destination: "me@new.invalid" }, true)).status).toBe(403);
  const added = await call("install", "POST", { destination: "me@lab.invalid" });
  expect(added.status).toBe(409);
  expect((await added.json() as { error: { code: string } }).error.code).toBe("install_unavailable");
  const started = await call("install", "POST", { destination: "me@new.invalid", name: "New" });
  expect(started.status).toBe(202);
  const job = await started.json() as PcInstallJob;
  expect(job).toMatchObject({ machine_id: null, mode: "install", phase: "connecting", target: { destination: "me@new.invalid" } });
  // one job at a time per PC: neither another install nor a setup goes there meanwhile
  expect((await call("install", "POST", { destination: "me@new.invalid" })).status).toBe(409);
  expect(() => manager.setup({ destination: "me@new.invalid" })).toThrow("Ovis is being installed on this PC");
  await until(() => waiting.has("me@new.invalid"));
  waiting.get("me@new.invalid")!.refuse("me@new.invalid: Permission denied (publickey).");
  await until(() => manager.installJob(job.id)?.phase === "failed");
  expect(await (await call(`install/${job.id}`, "GET")).json()).toMatchObject({ phase: "failed", error_code: "ssh_refused" });
  expect((await call("install/no-such-job", "GET")).status).toBe(404);
});

it("cancels a running install with DELETE, and with the PC's own update cancel or its removal", async () => {
  const { manager, internals, waiting, call, until } = fixture();
  const own: RemoteOvis = { version: "0.4.9", latest_version: null, updatable: false, reason: "That PC's Ovis does not update itself: it was not started by its updater.", address: "lab.invalid:7317", url: null };
  const offerInstall = () => {
    const runtime = internals.machines.get(SAVED)!;
    Object.assign(runtime.machine, { state: "error", action_required: "setup", remote_ovis: own });
    runtime.installFix = { mode: "replace", pid: 4242, target: { destination: "me@lab.invalid" } };
  };
  offerInstall();
  expect(manager.list().find((machine) => machine.id === SAVED)?.ovis_update).toMatchObject({ how: "install", updatable: true });
  const byRoute = await (await call("install", "POST", { machine_id: SAVED })).json() as PcInstallJob;
  expect(byRoute).toMatchObject({ machine_id: SAVED, mode: "replace" });
  expect((await (await call(`install/${byRoute.id}`, "DELETE")).json() as PcInstallJob).phase).toBe("cancelled");
  // through the update the devices list asks for, cancelled as any update is
  const { job_id } = await (await call(`${SAVED}/update`)).json() as { job_id: string };
  await until(() => waiting.has("me@lab.invalid"));
  expect(await (await call(`${SAVED}/update`, "DELETE")).json()).toEqual({ cancelled: true });
  await until(() => manager.installJob(job_id)?.phase === "cancelled");
  // and when the PC is removed while it installs
  const third = await (await call(`${SAVED}/update`)).json() as { job_id: string };
  manager.remove(SAVED);
  await until(() => manager.installJob(third.job_id)?.phase === "cancelled");
});
