import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FriendStore } from "./friends.ts";

const dirs: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), "project-friends-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const machines = [{ id: "local", snapshot: { panes: [
  { pane_id: "p1", workspace_id: "w1" }, { pane_id: "p2", workspace_id: "w1" },
  { pane_id: "child", workspace_id: "w2", parent_pane_id: "p1" },
  { pane_id: "other", workspace_id: "w2" },
] } }];

test("a project's panes and descendants wear one friend, including alerts before a browser lists them", () => {
  const store = new FriendStore(directory(), () => 0);
  const first = store.friendOf("local", "p1", machines);
  expect(store.friendOf("local", "p2", machines)).toBe(first);
  expect(store.friendOf("local", "child", machines)).toBe(first);
  expect(store.friendOf("local", "other", machines)).not.toBe(first);
  const answer = store.see(["local:p1", "local:p2", "local:child", "local:other"], ["local"], machines).friends;
  expect(answer["local:child"]).toBe(first);
});

test("project identity survives no live panes, a restart and new pane IDs; PCs stay separate", () => {
  const dir = directory();
  const first = new FriendStore(dir, () => 0.5).see(["local:p1"], ["local"], machines).friends["local:p1"]!;
  const store = new FriendStore(dir, () => 0);
  store.see([], ["local"], machines);
  const restarted = new FriendStore(dir, () => 0);
  expect(restarted.friendOf("local", "p2", machines)).toBe(first);
  const remote = [{ ...machines[0]!, id: "remote" }];
  expect(restarted.friendOf("remote", "p1", remote)).not.toBe(first);
});

test("migrates the first pane's old pick without rewriting legacy files on construction", () => {
  const dir = directory();
  const old = JSON.stringify({ "local:p1": "kuma", "local:p2": "neko" });
  writeFileSync(join(dir, "friends.json"), old);
  const store = new FriendStore(dir, () => 0);
  expect(readFileSync(join(dir, "friends.json"), "utf8")).toBe(old);
  expect(store.see(["local:p1", "local:p2"], ["local"], machines).friends).toEqual({ "local:p1": "kuma", "local:p2": "kuma" });
  // An older server rewriting its pane cache cannot erase the separate project choices.
  writeFileSync(join(dir, "friends.json"), JSON.stringify({ "local:p2": "neko" }));
  expect(new FriendStore(dir).friendOf("local", "p2", machines)).toBe("kuma");
});
