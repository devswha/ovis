import { expect, test } from "bun:test";
import { takeForAccount } from "./one-press.ts";
import { pairingPc, setUpFor } from "./pairing.test-helpers.ts";
import { askRecovery } from "./recovery.ts";

const server = { accountOpensAll: true, machines: false };

test("SSH add can inspect an independently installed PC before its first browser visit", async () => {
  const pc = await pairingPc({ server, startRelay: false });
  try {
    expect(await askRecovery(pc.stateDir, { act: "account_add_inspect" })).toMatchObject({ server_id: expect.any(String), account: null });
  } finally { await pc.close(); }
});

test("a refused SSH add preserves the account previously named on the PC", async () => {
  const pc = await pairingPc({ server });
  try {
    pc.account.opensAll = true;
    await setUpFor(pc, "acct_before");
    const { services } = pc.app.context;
    expect(await takeForAccount(services, "acct_after", services.relay.currentIdentity()!.server_id)).toHaveProperty("refused");
    expect(services.devices.account()).toBeNull();
    expect(services.relay.savedRelayAccount()).toBe("acct_before");
  } finally { await pc.close(); }
});
