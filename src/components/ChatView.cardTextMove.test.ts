import { expect, it } from "bun:test";
// ChatView keeps the prompt card's text, and carries it when herdr moves the pane under a new ID
import "./ChatView.tsx";
import { carryMovedPane } from "../lib/paneMove.ts";
import { CARD_TEXT_PREFIX, paneLifetimes } from "../lib/paneLifetime.ts";

it("carries the text typed into a pane's prompt card to the pane's new ID, for the pane it now is", () => {
  const typed = { machineId: "local", paneId: "w1:p1", session: "s1", promptId: "q1", text: "use the redis cache" };
  paneLifetimes.paneStorage.setItem(`${CARD_TEXT_PREFIX}w1:p1`, JSON.stringify(typed));
  carryMovedPane("local", "w1:p1", "w2:p4");
  expect(paneLifetimes.paneStorage.getItem(`${CARD_TEXT_PREFIX}w1:p1`)).toBeNull();
  expect(JSON.parse(paneLifetimes.paneStorage.getItem(`${CARD_TEXT_PREFIX}w2:p4`) ?? "null")).toEqual({ ...typed, paneId: "w2:p4" });
});
