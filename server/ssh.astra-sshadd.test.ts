import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshConnection } from "./ssh.ts";

test("a recovery socket under a state directory with spaces can reach OpenSSH", async () => {
  const root = mkdtempSync(join(tmpdir(), "sshadd-"));
  const remote = "/home/test/state files/recover/recover.sock";
  const dest = { destination: "localhost" };
  try {
    const parsed = Bun.spawnSync(["ssh", "-G", "-F", "none", "-L", `${root}/f:${remote}`, dest.destination]);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout.toString()).toContain(`localforward ${root}/f ${remote}`);
    const ssh = new SshConnection(dest, root);
    Object.defineProperty(ssh, "makeDir", { value: () => root });
    Object.defineProperty(ssh, "exec", { value: async () => "" });
    await expect(ssh.forwardSocket(remote)).resolves.toStartWith(root + "/fwd-");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
