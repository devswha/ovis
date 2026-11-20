import { afterEach, expect, spyOn, test } from "bun:test";
import { handleRequest, type ServerContext } from "../dispatch.ts";
import { createListedPc } from "./listed-pc.test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { accountRouteAction } from "./account-row-rights.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

async function listedDispatcher() {
  const { fixture, device, serverId } = await createListedPc(close => closes.push(close));
  const ctx: ServerContext = {
    ...fixture.app.context,
    peer: { kind: "relay", device: { id: device.id, label: "Laptop", role: "drive" }, key: device.publicKey, sessionId: "test", serverId },
    timeout() {}, requestIP: () => null, upgrade: () => false,
  };
  const request = (method: string, path: string) => handleRequest(new Request(`https://relay.ovis.invalid${path}`, {
    method, headers: { "x-herdr-machine": "1", "x-herdr-update": "1" }, ...(method === "POST" ? { body: "{}" } : {}),
  }), ctx);
  const rows = ctx.services.accountRows?.store();
  if (!rows) throw new Error("Listed PC has no account store");
  return { rows, device, request };
}

test("R1-R10: only registered methods and explicitly allowed reads reach dispatch", async () => {
  const { rows, device, request } = await listedDispatcher();
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  try {
    expect(rows.access(device.id)).toEqual({ ok: true });
    expect((await request("GET", "/api/preferences"))?.status).toBe(200);
    for (const [method, path] of [
      ["POST", "/api/unregistered"], ["GET", "/api/unregistered"], ["PATCH", "/api/preferences"],
      ["POST", "/api/machines/local/unregistered"], ["GET", "/api/machines/local/unregistered"],
    ] as const) {
      const response = await request(method, path);
      expect({ method, path, status: response?.status }).toEqual({ method, path, status: 403 });
    }
  } finally { clock.mockRestore(); }
});

test("R5, R8, R9: PC maintenance and webhook require authority; push unsubscribe has an explicit action", () => {
  for (const [method, path] of [
    ["POST", "/api/runtime/move"], ["DELETE", "/api/runtime/move"], ["POST", "/api/runtime/move/install"],
    ["POST", "/api/runtime/move/stop"], ["POST", "/api/runtime/move/stop-all"], ["POST", "/api/updates/cancel"],
  ] as const) {
    expect(accountRouteAction(method, path), `${method} ${path}`).not.toBeNull();
  }
  for (const method of ["PUT", "DELETE"]) expect(accountRouteAction(method, "/api/alerts/webhook")).toEqual({ action: "webhook" });
  expect(accountRouteAction("DELETE", "/api/push/subscribe")).toEqual({ action: "push_subscribe" });
});
