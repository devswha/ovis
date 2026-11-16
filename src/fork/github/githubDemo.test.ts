import { expect, test } from "bun:test";
import type { WorkspaceInfo } from "../../../shared/protocol.ts";
import { demoGithubPulls } from "./githubDemo.ts";

test("demo GitHub feed has both groups across two repositories and resolves current workspace IDs", () => {
  const workspaces: WorkspaceInfo[] = ["checkout-api", "cli-tools"].map((name, index) => ({
    workspace_id: `demo-${index}`, active_tab_id: "", agent_status: "idle", focused: false, label: name, number: index, pane_count: 0, tab_count: 0,
    worktree: { repo_name: name, repo_key: name, repo_root: `/demo/${name}`, checkout_path: `/demo/${name}`, is_linked_worktree: false },
  }));
  const listing = demoGithubPulls(workspaces);
  expect(listing.accounts).toEqual(["demo"]);
  expect(listing.review).toHaveLength(2);
  expect(listing.yours).toHaveLength(2);
  expect(new Set([...listing.review, ...listing.yours].map((pr) => pr.repository))).toEqual(new Set(["demo/checkout-api", "demo/cli-tools"]));
  for (const pr of [...listing.review, ...listing.yours]) {
    expect(pr.url).toBe(`https://github.com/${pr.repository}/pull/${pr.number}`);
    expect(pr.workspace_id).toBe(workspaces.find((workspace) => `demo/${workspace.worktree?.repo_name}` === pr.repository)?.workspace_id);
  }
  expect([...demoGithubPulls([]).review, ...demoGithubPulls([]).yours].every((pr) => pr.workspace_id === undefined)).toBe(true);
});
