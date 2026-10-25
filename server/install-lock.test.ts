import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLockOwner, POSIX_INSTALL_LOCK, POSIX_INSTALL_RELEASE, WINDOWS_INSTALL_LOCK, WINDOWS_INSTALL_RELEASE, withWindowsInstallAttempt } from "./remote-host.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function acquire() {
  const base = mkdtempSync(join(tmpdir(), "install-lock-"));
  dirs.push(base);
  const lock = join(base, "install.lock");
  const run = () => Bun.spawnSync(["sh", "-c", `set -eu; base=${JSON.stringify(base)}; ${POSIX_INSTALL_LOCK} printf acquired`]);
  const sh = (script: string) => Bun.spawnSync(["sh", "-c", `set -eu; base=${JSON.stringify(base)}; ${script}`]);
  return { lock, run, sh };
}

describe("POSIX install lock", () => {
  it("takes a free lock and records its owner", () => {
    const { lock, run } = acquire();
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(lock, "pid"))).toBe(true);
  });

  it("refuses a lock held by a live installer", () => {
    const { lock, run } = acquire();
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(process.pid));
    const result = run();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Another installation is in progress");
    expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(process.pid));
  });

  it("reclaims a lock whose owner is gone", () => {
    const { lock, run } = acquire();
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), "2147483646");
    expect(run().exitCode).toBe(0);
    expect(readFileSync(join(lock, "pid"), "utf8")).not.toBe("2147483646");
  });

  it("reclaims a lock older than any install can run, even with a live owner", () => {
    const { lock, run } = acquire();
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(process.pid));
    const old = new Date(Date.now() - 40 * 60_000);
    utimesSync(lock, old, old);
    expect(run().exitCode).toBe(0);
    expect(readFileSync(join(lock, "pid"), "utf8")).not.toBe(String(process.pid));
  });

  it("leaves the lock alone while another installer holds the reclaim mutex", () => {
    const { lock, run } = acquire();
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), "2147483646");
    mkdirSync(`${lock}.reclaim`);
    const result = run();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Another installation is in progress");
    expect(readFileSync(join(lock, "pid"), "utf8")).toBe("2147483646");
  });

  it("drops a reclaim mutex its holder died with, so the retry takes the lock", () => {
    const { lock, run } = acquire();
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), "2147483646");
    mkdirSync(`${lock}.reclaim`);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(`${lock}.reclaim`, old, old);
    expect(run().exitCode).toBe(1);
    expect(existsSync(`${lock}.reclaim`)).toBe(false);
    expect(run().exitCode).toBe(0);
    expect(existsSync(`${lock}.reclaim`)).toBe(false);
  });

  it("releases a lock it still owns", () => {
    const { lock, sh } = acquire();
    expect(sh(`${POSIX_INSTALL_LOCK} ${POSIX_INSTALL_RELEASE}`).exitCode).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it("keeps a lock a newer installer took over", () => {
    const { lock, sh } = acquire();
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), "2147483646");
    expect(sh(`lock="$base/install.lock"; ${POSIX_INSTALL_RELEASE}`).exitCode).toBe(0);
    expect(readFileSync(join(lock, "pid"), "utf8")).toBe("2147483646");
  });
});

/**
 * The Windows mirror, run through `pwsh` wherever it exists (the GitHub Linux runner has it) so the
 * scripts are exercised rather than only spelled out. The lock's owner is this server, so a lock
 * whose owner token matches is this server's own leftover and is reclaimed at once; a peer's lock
 * waits for the install's longest life, as on POSIX.
 */
const pwsh = Bun.which("pwsh");
const psq = (value: string) => `'${value.replaceAll("'", "''")}'`;

function acquireWindows(reclaim = "test-host") {
  const base = mkdtempSync(join(tmpdir(), "install-lock-win-"));
  dirs.push(base);
  const lock = join(base, "install.lock");
  let attempt = 0;
  const script = (body: string) => ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; $base = ${psq(base)}; $reclaim = ${psq(reclaim)}; $owner = ${psq(`${reclaim}:owner`)}; ${body}`] as const;
  const run = (who = `${reclaim}:${++attempt}`) => Bun.spawnSync([pwsh!, ...script(`$owner = ${psq(who)}; ${WINDOWS_INSTALL_LOCK}; Write-Output 'acquired'`)]);
  const sh = (body: string) => Bun.spawnSync([pwsh!, ...script(body)]);
  return { base, lock, run, sh };
}

it("keeps the stable Windows owner ASCII-safe and target-specific", () => {
  const owner = installLockOwner("/tmp/사용자 상태", { destination: "사용자@호스트", port: 22 });
  expect(owner).toMatch(/^[a-f0-9]{64}$/);
  expect(installLockOwner("/tmp/사용자 상태", { destination: "사용자@호스트", port: 22 })).toBe(owner);
  expect(installLockOwner("/tmp/사용자 상태", { destination: "다른@호스트", port: 22 })).not.toBe(owner);
});

it("gives a target one live Windows install attempt and exact cleanup ownership", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = withWindowsInstallAttempt("server-target", async (owner) => {
    entered.resolve();
    await release.promise;
    return owner;
  });
  await entered.promise;
  let refused: unknown;
  try { await withWindowsInstallAttempt("server-target", async () => "second"); }
  catch (error) { refused = error; }
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toContain("Another installation is in progress");
  release.resolve();
  const firstOwner = await first;
  const secondOwner = await withWindowsInstallAttempt("server-target", async (owner) => owner);
  expect(firstOwner).not.toBe(secondOwner);
  expect(firstOwner.startsWith("server-target:")).toBe(true);
  expect(secondOwner.startsWith("server-target:")).toBe(true);
});

describe.skipIf(!pwsh)("Windows install lock", () => {
  it("takes a free lock and records this server as its owner", () => {
    const { lock, run } = acquireWindows();
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("test-host:1");
  });

  it("refuses a lock held by another installer", () => {
    const { lock, run } = acquireWindows();
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "peer-host:9");
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Another installation is in progress");
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("peer-host:9");
  });

  it("reclaims a lock this server left behind", () => {
    const { lock, run } = acquireWindows();
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "test-host:old");
    expect(run().exitCode).toBe(0);
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("test-host:1");
  });

  it("reclaims a peer's lock older than any install can run", () => {
    const { lock, run } = acquireWindows();
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "peer-host:9");
    const old = new Date(Date.now() - 40 * 60_000);
    utimesSync(lock, old, old);
    expect(run().exitCode).toBe(0);
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("test-host:1");
  });

  it("leaves a live peer's lock alone while another installer holds the reclaim mutex", () => {
    const { lock, run } = acquireWindows();
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "peer-host:9");
    mkdirSync(`${lock}.reclaim`);
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Another installation is in progress");
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("peer-host:9");
    expect(existsSync(`${lock}.reclaim`)).toBe(true);
  });

  it("drops a reclaim mutex its holder died with, so the retry takes the lock", () => {
    const { lock, run } = acquireWindows();
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "test-host:old");
    mkdirSync(`${lock}.reclaim`);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(`${lock}.reclaim`, old, old);
    expect(run().exitCode).not.toBe(0);
    expect(existsSync(`${lock}.reclaim`)).toBe(false);
    expect(run().exitCode).toBe(0);
    expect(existsSync(`${lock}.reclaim`)).toBe(false);
  });

  it("keeps a live peer's lock after a dead reclaim mutex is dropped", () => {
    const { lock, run } = acquireWindows();
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "peer-host:9");
    mkdirSync(`${lock}.reclaim`);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(`${lock}.reclaim`, old, old);
    expect(run().exitCode).not.toBe(0);
    expect(run().exitCode).not.toBe(0);
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("peer-host:9");
  });

  it("releases a lock it still owns", () => {
    const { lock, sh } = acquireWindows();
    expect(sh(`${WINDOWS_INSTALL_LOCK}; ${WINDOWS_INSTALL_RELEASE}`).exitCode).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it("keeps a lock a newer installer took over", () => {
    const { lock, sh } = acquireWindows();
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "test-host:newer");
    expect(sh(WINDOWS_INSTALL_RELEASE).exitCode).toBe(0);
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe("test-host:newer");
  });
});
