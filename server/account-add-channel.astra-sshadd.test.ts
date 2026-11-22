import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountAddChannel } from "./account-add-channel.ts";
import { SshConnection } from "./ssh.ts";

test("closing the forward also ends an already accepted recovery request", async () => {
  const root = mkdtempSync(join(tmpdir(), "sshadd-"));
  const path = join(root, "f.sock");
  const ssh = new SshConnection({ destination: "fixture" }, root);
  const request = Promise.withResolvers<Socket>();
  const listener = createServer((socket) => socket.once("data", () => request.resolve(socket)));
  await new Promise<void>((resolve) => listener.listen(path, resolve));
  spyOn(ssh, "forwardSocket").mockResolvedValue(path);
  spyOn(ssh, "closeSocketForward").mockImplementation(async () => { listener.close(); });
  const channel = await AccountAddChannel.open(ssh, path);
  let socket: Socket | undefined;
  try {
    const pending = channel.take("acct_1", "1".repeat(32)).then(() => "accepted late reply", () => "closed");
    socket = await request.promise;
    await channel.close();
    expect(listener.listening).toBe(false);
    socket.end(JSON.stringify({ account: "acct_1" }) + "\n");
    expect(await pending).toBe("closed");
  } finally { await channel.close(); socket?.destroy(); rmSync(root, { recursive: true, force: true }); }
});
