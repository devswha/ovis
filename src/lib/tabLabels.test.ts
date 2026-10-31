import { afterEach, describe, expect, it } from "bun:test";

import type { Machine } from "../../shared/machines.ts";
import { MAX_TAB_LABEL_LENGTH } from "../../shared/preferences.ts";
import { autoTabLabel } from "./tabName.ts";
import { currentTabLabels, firstPromptOf, learnFromConversation, learnFromSend, learnTabLabel, setTabLabelLearning, setTabLabels, settleTabLabels, shortTabLabel } from "./tabLabels.ts";

afterEach(() => { setTabLabelLearning(true, false); setTabLabels({}); settleTabLabels([]); });

type Pc = Pick<Machine, "id" | "state" | "snapshot">;
const pc = (id: string, panes: { pane_id: string; terminal_id: string }[], state: Machine["state"] = "connected"): Pc =>
  ({ id, state, snapshot: { panes } } as unknown as Pc);

describe("tab labels from the first message", () => {
  it("keeps a few words of the first line that names something, never the message", () => {
    expect(shortTabLabel("\n  \n  Fix   the\tlogin  \nand more")).toBe("Fix the login");
    expect(shortTabLabel("Fix the login redirect after the session expires")).toBe("Fix the login redirect…");
    expect(shortTabLabel("  \n ")).toBeNull();
    // a slash command, a path or a code fence names nothing: the next line does, or none
    expect(shortTabLabel("/review\nCheck the parser")).toBe("Check the parser");
    expect(shortTabLabel("~/dev/api/main.ts\n```ts\nconst x = 1")).toBe("const x = 1");
    expect(shortTabLabel("/compact")).toBeNull();
    for (const text of ["a".repeat(500), "👩‍💻".repeat(30), "로그인".repeat(40)]) expect(shortTabLabel(text)!.length).toBeLessThanOrEqual(MAX_TAB_LABEL_LENGTH);
  });

  it("counts a wide character as two columns, and never splits one", () => {
    expect(shortTabLabel("로그인리다이렉트를고쳐주세요세션이만료된뒤에도계속")).toBe("로그인리다이렉트를고쳐주…");
    expect(shortTabLabel("로그인 리다이렉트를 고쳐 주세요")).toBe("로그인 리다이렉트를…");
    expect(shortTabLabel("👩‍💻".repeat(30))).toBe(`${"👩‍💻".repeat(12)}…`);
  });

  it("keys a label to the pane and its terminal once the pane is seen, and learns it once", () => {
    learnTabLabel("local", "w1:p1", "Fix the login");
    learnTabLabel("local", "w1:p1", "Something later");
    expect(currentTabLabels()).toEqual({});
    settleTabLabels([pc("local", [{ pane_id: "w1:p1", terminal_id: "term_a" }])]);
    expect(currentTabLabels()).toEqual({ "w1:p1|term_a": "Fix the login" });
    learnTabLabel("local", "w1:p1", "Another");
    settleTabLabels([pc("local", [{ pane_id: "w1:p1", terminal_id: "term_a" }])]);
    expect(currentTabLabels()).toEqual({ "w1:p1|term_a": "Fix the login" });
  });

  it("never shows an old pane's label on a pane that reuses its id after a restart, and learns the new one's", () => {
    const before = [pc("local", [{ pane_id: "w1:p1", terminal_id: "term_a" }])];
    const after = [pc("local", [{ pane_id: "w1:p1", terminal_id: "term_b" }])];
    learnTabLabel("local", "w1:p1", "Old session");
    settleTabLabels(before);
    expect(currentTabLabels()).toEqual({ "w1:p1|term_a": "Old session" });
    // herdr restarted: w1:p1 is back, on another terminal. The old label was seen, so it leaves
    settleTabLabels(after);
    expect(currentTabLabels()).toEqual({});
    expect(autoTabLabel({ label: "1", number: 1 }, after[0]!.snapshot!.panes, "local", { "w1:p1|term_a": "Old session" })).toBeNull();
    learnTabLabel("local", "w1:p1", "New session");
    settleTabLabels(after);
    expect(currentTabLabels()).toEqual({ "w1:p1|term_b": "New session" });
  });

  it("drops a label only after seeing its pane and then a connected PC without it", () => {
    // another browser shared it before this page's roster has the pane: it stays
    setTabLabels({ "w1:p9|term_z": "Just shared", "w1:p2|term_b": "Here" });
    settleTabLabels([pc("local", [{ pane_id: "w1:p2", terminal_id: "term_b" }])]);
    expect(currentTabLabels()).toEqual({ "w1:p9|term_z": "Just shared", "w1:p2|term_b": "Here" });
    // the roster catches up, then the pane closes
    settleTabLabels([pc("local", [{ pane_id: "w1:p2", terminal_id: "term_b" }, { pane_id: "w1:p9", terminal_id: "term_z" }])]);
    settleTabLabels([pc("local", [{ pane_id: "w1:p2", terminal_id: "term_b" }])]);
    expect(currentTabLabels()).toEqual({ "w1:p2|term_b": "Here" });
    // a PC that is away drops none
    settleTabLabels([pc("local", [], "disconnected")]);
    expect(currentTabLabels()).toEqual({ "w1:p2|term_b": "Here" });
  });

  it("drops a label seen gone again when a save brings it back, and an old terminal's label blocks no new one", () => {
    const open = [pc("local", [{ pane_id: "w1:p1", terminal_id: "term_a" }])];
    learnTabLabel("local", "w1:p1", "Closing soon");
    settleTabLabels(open);
    settleTabLabels([pc("local", [])]);
    expect(currentTabLabels()).toEqual({});
    // the answer to the save that carried it lands after the pane closed
    setTabLabels({ "w1:p1|term_a": "Closing soon" });
    settleTabLabels([pc("local", [])]);
    expect(currentTabLabels()).toEqual({});
    // after a reload, an old label of a reused pane id was never seen here: it stays, unseen, and the new terminal learns its own
    setTabLabels({ "w1:p2|term_old": "Old" });
    learnTabLabel("local", "w1:p2", "New");
    settleTabLabels([pc("local", [{ pane_id: "w1:p2", terminal_id: "term_new" }])]);
    expect(currentTabLabels()).toEqual({ "w1:p2|term_old": "Old", "w1:p2|term_new": "New" });
  });

  it("learns nothing while the setting is off", () => {
    setTabLabelLearning(false, false);
    learnTabLabel("local", "w1:p1", "Fix it");
    setTabLabelLearning(true, false);
    settleTabLabels([pc("local", [{ pane_id: "w1:p1", terminal_id: "term_a" }])]);
    expect(currentTabLabels()).toEqual({});
  });

  it("a watching device shows the labels and learns none", () => {
    setTabLabels({ "w1:p1|term_a": "Shared" });
    setTabLabelLearning(true, true);
    learnTabLabel("local", "w1:p2", "Mine");
    settleTabLabels([pc("local", [{ pane_id: "w1:p1", terminal_id: "term_a" }, { pane_id: "w1:p2", terminal_id: "term_b" }])]);
    expect(currentTabLabels()).toEqual({ "w1:p1|term_a": "Shared" });
  });

  it("learns from a transcript read from its beginning, and from a send only where no transcript says", () => {
    const panes = [pc("local", [{ pane_id: "w7:p1", terminal_id: "term_q" }, { pane_id: "w7:p2", terminal_id: "term_r" }])];
    const user = (text: string) => ({ role: "user" as const, ts: null, parts: [{ kind: "text" as const, text }] });
    learnFromConversation("local", "w7:p1", { source: "codex-transcript", cursor: "c:4", turns: [user("A later message")] });
    learnFromSend("local", "w7:p1", "Typed in Chat");
    learnFromConversation("local", "w7:p1", { source: "codex-transcript", cursor: null, turns: [user("The first one")] });
    learnFromConversation("local", "w7:p2", { source: "scrollback", turns: [] });
    learnFromSend("local", "w7:p2", "Sent to a shell agent");
    settleTabLabels(panes);
    expect(currentTabLabels()).toEqual({ "w7:p1|term_q": "The first one", "w7:p2|term_r": "Sent to a shell agent" });
  });

  it("finds the first message with words in turns read from the beginning", () => {
    expect(firstPromptOf([
      { role: "user", ts: null, parts: [{ kind: "image", media_type: "image/png", ref: "r" }] },
      { role: "assistant", ts: null, parts: [{ kind: "text", text: "Hi" }] },
      { role: "user", ts: null, parts: [{ kind: "text", text: "Fix it" }, { kind: "text", text: "now" }] },
    ])).toBe("Fix it\nnow");
    expect(firstPromptOf([{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Hi" }] }])).toBeNull();
  });
});
