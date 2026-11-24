import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_REVIEW, OPEN_REVIEW, askable, claudeManagedPolicy, permissionLaunch } from "./permission-launch.ts";

it("an unknown parent can launch only the named all-ask profile, never an adapter default", () => {
  const cmd = { argv: ["/bin/opencode", "acp"] };
  const recipe = permissionLaunch("opencode", undefined, "abc123", cmd);
  if (!recipe?.env?.OPENCODE_CONFIG_CONTENT) throw new Error("No all-ask launch policy");
  const config = JSON.parse(recipe.env.OPENCODE_CONFIG_CONTENT);
  expect(config.default_agent).toBe("ovis-ask-abc123");
  expect(config.agents[config.default_agent].permissions).toEqual([{ action: "*", resource: "*", effect: "ask" }]);
  expect(recipe.ceiling.mode).toBe(config.default_agent);
  expect(recipe.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
  expect(recipe).toMatchObject({ askEveryTime: true, privateFiles: { OPENCODE_DB: "opencode.db" } });
  for (const kind of ["codex","gjc","agy","copilot"]) {
    expect(askable(kind)).toBe(false);
    expect(permissionLaunch(kind, undefined, "abc123", cmd)).toBeNull();
  }
  expect(permissionLaunch("opencode", "readonly", "abc123", cmd)).toBeNull();
});

it("Claude's all-ask launch sets its mode before the session answers and loads no user, project or hook setting", () => {
  const cmd = { argv: ["/bin/claude-agent-acp", "--hide-claude-auth"], env: { CLAUDE_CODE_EXECUTABLE: "/bin/claude" } };
  const recipe = permissionLaunch("claude", undefined, "abc123", cmd);
  if (!recipe) throw new Error("No all-ask launch for Claude");
  expect(recipe).toMatchObject({ argv: cmd.argv, env: cmd.env, askEveryTime: true, ceiling: { profile: CLAUDE_REVIEW, mode: "default" },
    configOptions: [{ configId: "mode", value: "default" }] });
  expect(recipe.sessionMeta).toEqual({ claudeCode: { options: { settingSources: [], allowDangerouslySkipPermissions: false, settings: {
    disableAllHooks: true, sandbox: { autoAllowBashIfSandboxed: false },
    permissions: { defaultMode: "default", ask: ["Write", "Edit", "Bash", "WebFetch", "WebSearch", "mcp__ovis-agent"] } } } } });
  expect(permissionLaunch("claude", OPEN_REVIEW, "abc123", cmd)?.ceiling.profile).toBe(CLAUDE_REVIEW);
  expect(permissionLaunch("opencode", CLAUDE_REVIEW, "abc123", { argv: ["/bin/opencode"] })?.ceiling.profile).toBe(OPEN_REVIEW);
  expect(permissionLaunch("claude", "readonly", "abc123", cmd)).toBeNull();
});

it("a managed Claude Code policy file refuses the Claude launch", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-"));
  try {
    const policy = join(dir, "managed-settings.json");
    expect(claudeManagedPolicy([policy])).toBeNull();
    writeFileSync(policy, "{}");
    expect(claudeManagedPolicy([policy])).not.toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
