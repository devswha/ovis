import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lettaStore from "../letta-store.ts";
import { lettaMessagesPath } from "../letta-store.ts";
import { hub, root } from "./status.fake.ts";

// A herdr-core Letta pane: Letta sends no report, so herdr gives it no status (letta-code 0.34.44, hc 0.1.17)
const letta = (title: string, status = "unknown") => ({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "letta", agent_status: status, cwd: root, foreground_cwd: root, terminal_title: title, title });
// One turn of letta-code 0.34.44's local backend: the prompt, a Bash call, its result, the answer
const turn = readFileSync(join(import.meta.dir, "..", "fixtures", "letta", "messages-turn-0.34.44.jsonl"), "utf8").trim().split("\n");

const resolved: { mockRestore(): void }[] = [];
const resolving = () => { const spy = spyOn(lettaStore, "resolveLettaTranscript"); resolved.push(spy); return spy; };
afterEach(() => { for (const spy of resolved.splice(0)) spy.mockRestore(); });

describe("a Letta pane's status in the hub, where no report gives one", () => {
  it("works while Letta's title spins and finishes once when it stops, from the title alone", async () => {
    const h = hub();
    resolving().mockResolvedValue(null);
    h.herdrSays(letta("⠋ Tutor"));
    await h.snapshot();
    expect(h.last().status).toBe("working");
    h.herdrSays(letta("Tutor"));
    await h.snapshot();
    expect(h.last().status).toBe("done");
    expect(h.alerts.filter((alert) => alert === "done")).toHaveLength(1);
  });

  it("tells no turn from a read that began before one already applied and finished after it", async () => {
    const h = hub();
    resolving().mockResolvedValue(null);
    h.herdrSays(letta("⠋ Tutor"));
    await h.snapshot();
    // a read begins while the spinner still turns, and is answered only after a newer read saw it stop
    const release = await h.heldSnapshot();
    h.herdrSays(letta("Tutor"));
    await h.snapshot();
    expect(h.last().status).toBe("done");
    await release();
    expect(h.last().status).toBe("done");
    expect(h.alerts.filter((alert) => alert === "done")).toHaveLength(1);
  });

  it("keeps a status the program reports over its title", async () => {
    const h = hub();
    resolving().mockResolvedValue(null);
    h.herdrSays(letta("⠋ Tutor", "blocked"));
    const snapshot = await h.snapshot();
    expect(snapshot.panes[0]!.agent_status).toBe("blocked");
  });

  it("shows a file-tracked pane as blocked while its pending call waits for the user's approval", async () => {
    const store = join(root, "letta-store-asking");
    const agent = "agent-local-b";
    const messages = lettaMessagesPath(store, agent, "default")!;
    mkdirSync(join(messages, ".."), { recursive: true });
    // the prompt and the call waiting for approval: nothing more is written until the user answers
    writeFileSync(messages, `${turn.slice(0, 2).join("\n")}\n`);
    const h = hub();
    resolving().mockResolvedValue({ path: join(root, "t2.jsonl"), session: `default:${agent}`, agent, conversation: "default", store, startedAt: 0 });
    h.herdrSays(letta("⠋ Tutor"));
    await h.snapshot();
    expect(h.last().status).toBe("working");
    h.herdrSays(letta("[ ! ] Action Required | Tutor"));
    const snapshot = await h.snapshot();
    expect(snapshot.panes[0]!.agent_status).toBe("blocked");
    expect(h.last().status).toBe("blocked");
  });

  it("works through a turn in Letta's local messages and finishes once, and gives the pane back to a report", async () => {
    const store = join(root, "letta-store");
    const agent = "agent-local-a";
    const messages = lettaMessagesPath(store, agent, "default")!;
    mkdirSync(join(messages, ".."), { recursive: true });
    writeFileSync(messages, `${turn.slice(0, 2).join("\n")}\n`);
    const h = hub();
    resolving().mockResolvedValue({ path: join(root, "t.jsonl"), session: `default:${agent}`, agent, conversation: "default", store, startedAt: 0 });
    h.herdrSays(letta("Tutor"));
    await h.snapshot();
    expect(h.status.letta.tracks("w1:p1")).toBe(true);
    expect(h.last().status).toBe("working");
    appendFileSync(messages, `${turn.slice(2).join("\n")}\n`);
    await h.status.letta.poll();
    expect(h.last().status).toBe("done");
    expect(h.alerts.filter((alert) => alert === "done")).toHaveLength(1);
    // a report takes the pane back from Letta's own files
    h.herdrSays(letta("Tutor", "working"));
    const snapshot = await h.snapshot();
    expect(h.status.letta.runs("w1:p1")).toBe(false);
    expect(snapshot.panes[0]!.agent_status).toBe("working");
  });
});
