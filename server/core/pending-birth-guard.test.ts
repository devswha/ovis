import { afterEach, expect, it, mock, spyOn } from "bun:test";

import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import * as client from "../herdr/client.ts";
import * as opencode from "../opencode-native.ts";
import * as processStart from "../process-start.ts";
import { connectionData, type Client } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";

afterEach(() => { mock.restore(); });

const PROMPT = "Enter passphrase for key '/tmp/key': ";

/**
 * A queued message to an idle gjc pane (pid 41001), drained. `after` runs once the catalog the paste is prepared with
 * was read, the last await before the final checks of the paste; `afterPaste` once the paste was written. Both may
 * replace what the pane shows or runs, as another process or a prompt can between a check and herdr's write.
 */
async function drain({ after = () => {}, afterPaste = () => {} }: { after?: (pane: Pane) => void; afterPaste?: (pane: Pane) => void }) {
  const shown: Pane = { birth: 1_000 as number | null, screen: "", foreground: [{ pid: 41001, name: "gjc", argv: ["gjc"] }] };
  spyOn(processStart, "processStartedAtAsync").mockImplementation(async () => shown.birth);
  spyOn(client, "paneProcessInfo").mockImplementation(async () => {
    shown.onProcessRead?.();
    return { pane_id: "p", shell_pid: 41000, foreground_processes: shown.foreground };
  });
  spyOn(client, "paneRead").mockImplementation(async () => ({ text: shown.screen }) as Awaited<ReturnType<typeof client.paneRead>>);
  const skillsToType = opencode.openCodeSkillsToType;
  spyOn(opencode, "openCodeSkillsToType").mockImplementation(async (...args: Parameters<typeof skillsToType>) => {
    const result = await skillsToType(...args);
    after(shown);
    return result;
  });
  const writes: string[] = [];
  spyOn(client, "paneSendText").mockImplementation(async () => { writes.push("paste"); afterPaste(shown); });
  spyOn(client, "paneSendKeys").mockImplementation(async (_pane: string, keys: string[]) => { writes.push(keys.join("+")); });

  const pane = { pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "gjc", agent_status: "working", cwd: "/tmp", focused: false, revision: 0 } as HerdrPane;
  const owner = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: () => 1 } as unknown as Client;
  owner.data.attached.set("p", { keepSize: false });
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => { const run = tail.catch(() => {}).then(task); tail = run; return run; };
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 120 };
  const delivery = createPendingDelivery({
    options: { submitDelayMs: 0 }, clients: new Set([owner]), attachments: new Map(),
    sight: (() => ({ facts: () => facts, write: () => {} })) as unknown as Parameters<typeof createPendingDelivery>[0]["sight"],
    serialize, lastTyped: new Map(), submitText: async () => {}, authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [{ ...pane }] }) as unknown as SessionSnapshot,
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 1_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  await delivery.pendingFrames.submit(owner, { type: "submit", id: 1, pane_id: "p", text: "FOLLOWUP", payload: "FOLLOWUP", delivery: "queue" });
  pane.agent_status = "idle";
  delivery.pending.status("p", "idle");
  delivery.drainPending("p");
  for (let lane = 0; lane < 3; lane++) await serialize("p", () => {});
  return writes;
}
interface Pane { birth: number | null; screen: string; foreground: Array<{ pid: number; name: string; argv: string[] }>; onProcessRead?: () => void }

it("types nothing into another process that took the agent's PID before the paste", async () => {
  expect(await drain({ after: (pane) => { pane.birth = 2_000; } })).toEqual([]);
});

it("types nothing once the agent's known start can no longer be read at its PID", async () => {
  expect(await drain({ after: (pane) => { pane.birth = null; } })).toEqual([]);
});

it("withholds the Enter from another process that took the agent's PID after the paste", async () => {
  expect(await drain({ afterPaste: (pane) => { pane.birth = 2_000; } })).toEqual(["paste"]);
});

it("types nothing into a masked prompt that appears during the last process check before the paste", async () => {
  // the next process read is the last check's: the prompt comes up while it is answered
  expect(await drain({ after: (pane) => { pane.onProcessRead = () => { pane.screen = PROMPT; }; } })).toEqual([]);
});

it("withholds the Enter from a masked prompt that appears during the last process check before it", async () => {
  // the check before Enter reads the screen, then the process: the prompt comes up at the last process read
  expect(await drain({ afterPaste: (pane) => { let reads = 0; pane.onProcessRead = () => { if (++reads >= 3) pane.screen = PROMPT; }; } })).toEqual(["paste"]);
});
