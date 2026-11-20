import { afterEach, expect, spyOn, test } from "bun:test";
import { signSafetyRecord } from "../../shared/account-records.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { phone } from "./pairing.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

test("T52: a service freeze withdraws a listed row's lift authority", async () => {
  const { fixture, service, device } = await createListedPc(close => closes.push(close));
  const { devices, safetyLog, accountMailbox } = fixture.app.context.services;
  if (!safetyLog) throw new Error("Expected a safety log");
  const signer = await phone();
  const peer = await phone();
  const signerNo = service.registerDevice(ACCOUNT, signer.spki, "Signer");
  const peerNo = service.registerDevice(ACCOUNT, peer.spki, "Peer");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const time = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS + 1);
  closes.push(() => time.mockRestore());
  const target = "a".repeat(64);
  const at = new Date().toISOString();
  const line = { v: 1, kind: "freeze", id: `f:${target}`, account: ACCOUNT, target: peer.spki, after: peerNo,
    signer: "service", signed_at: at, signature: "" } as const;
  expect(safetyLog.append({ record: line, got: "snapshot" }).outcome).toBe("applied");
  const record = await signSafetyRecord({ v: 1, kind: "lift", target, account: ACCOUNT,
    signer: signer.spki, signer_no: signerNo, signed_at: at }, signer.keys.privateKey);
  expect(await devices.liftAuthority(record)).toBe(true);

  const restriction = { ...line, id: `f:${"b".repeat(64)}`, target: device.publicKey, after: signerNo - 1 };
  expect(safetyLog.append({ record: restriction, got: "snapshot" }).outcome).toBe("applied");
  expect(await devices.liftAuthority(record)).toBe(false);
  expect(safetyLog.state().freezes.map(entry => entry.record.id)).toContain(line.id);
});
