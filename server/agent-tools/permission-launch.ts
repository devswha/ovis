import { existsSync } from "node:fs";
import { runVersion, VERSION_TIMEOUT_MS } from "../agent-catalog-detect.ts";
import type { HarnessCommand } from "./harnesses.ts";

/** The name Ovis gives its own MCP server in a child, which the Claude recipe's ask rule names. */
export const AGENT_MCP_SERVER = "ovis-agent";
export const OPEN_REVIEW = "opencode/all-tools-ask/v1";
export const CLAUDE_REVIEW = "claude/all-tools-ask/v1";

export type Verified = HarnessCommand & {
  ceiling: { profile: string; mode: string };
  /** the keeper keeps only one-time choices on the child's cards */
  askEveryTime?: boolean;
  /** `_meta` and `configOptions` of the child's `session/new` */
  sessionMeta?: unknown;
  configOptions?: readonly unknown[];
  /** environment variables naming a file in the child's private keeper folder */
  privateFiles?: Record<string, string>;
};

interface AskRecipe {
  profile: string;
  /** the program whose `--version` answer must be one this recipe was run against */
  versioned: (command: HarnessCommand) => string | undefined;
  versions: RegExp;
  /** a reason this PC's own setup could answer for the person, which the launch cannot override */
  blocked?: () => string | null;
  launch: (command: HarnessCommand, runId: string) => Omit<Verified, "ceiling" | keyof HarnessCommand> & { mode: string; env?: Record<string, string> };
}

const CLAUDE_MANAGED = ["/etc/claude-code/managed-settings.json", "/etc/claude-code/managed-settings.d",
  "/Library/Application Support/ClaudeCode/managed-settings.json", "/Library/Application Support/ClaudeCode/managed-settings.d"];
/** Managed settings outrank every setting a launch can pass, and their rules and hooks may answer for the person. */
export const claudeManagedPolicy = (paths: readonly string[] = CLAUDE_MANAGED): string | null =>
  paths.some(path => existsSync(path)) ? "A managed Claude Code policy on this PC could answer for the person." : null;

/**
 * Launches whose every write, side-effecting command, web request and MCP call was seen to reach the
 * ACP client as a permission request, with the user's and the project's own approvals in place
 * (docs/harness-tool.md). Only the versions those runs used are accepted.
 */
const ASK_RECIPES: Record<string, AskRecipe> = {
  opencode: {
    profile: OPEN_REVIEW,
    versioned: command => command.argv[0],
    versions: /^(?:opencode v?)?2\.2\.2$/,
    launch: (_command, runId) => {
      const mode = `ovis-ask-${runId}`;
      const permissions = [{ action: "*", resource: "*", effect: "ask" }];
      return {
        mode,
        privateFiles: { OPENCODE_DB: "opencode.db" },
        env: {
          OPENCODE_CONFIG_PROJECT_DISABLE: "1",
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ default_agent: mode, permissions, agents: { [mode]: { mode: "primary", permissions } } }),
        },
      };
    },
  },
  claude: {
    profile: CLAUDE_REVIEW,
    versioned: command => command.env?.["CLAUDE_CODE_EXECUTABLE"],
    versions: /^2\.1\.330 \(Claude Code\)$/,
    blocked: () => claudeManagedPolicy(),
    // The adapter starts in `auto` and reads `permissions.defaultMode` itself, past `settingSources`:
    // the mode option is applied before `session/new` answers, so no other mode runs first.
    launch: () => ({
      mode: "default",
      configOptions: [{ configId: "mode", value: "default" }],
      sessionMeta: { claudeCode: { options: {
        settingSources: [],
        allowDangerouslySkipPermissions: false,
        settings: {
          disableAllHooks: true,
          permissions: { defaultMode: "default", ask: ["Write", "Edit", "Bash", "WebFetch", "WebSearch", `mcp__${AGENT_MCP_SERVER}`] },
          sandbox: { autoAllowBashIfSandboxed: false },
        },
      } } },
    }),
  },
};
const ASK_PROFILES = new Set(Object.values(ASK_RECIPES).map(recipe => recipe.profile));

export const askable = (kind: string): boolean => Object.hasOwn(ASK_RECIPES, kind);

/** Why this harness cannot get its ask-for-everything launch here: an untested version or a setup it cannot override. */
export async function askRefusal(kind: string, command: HarnessCommand): Promise<string | null> {
  const recipe = Object.hasOwn(ASK_RECIPES, kind) ? ASK_RECIPES[kind]! : null;
  if (!recipe) return "This harness has no verified ask-for-everything launch.";
  const blocked = recipe.blocked?.();
  if (blocked) return blocked;
  const bin = recipe.versioned(command);
  const probe = bin ? await runVersion(bin, ["--version"], VERSION_TIMEOUT_MS) : null;
  return probe && probe.exitCode === 0 && recipe.versions.test(probe.stdout.trim()) ? null : "This version has no verified ask-for-everything launch.";
}

/** Never infer permissions from an adapter's mode name. For an unverified parent only a recipe
 * from ASK_RECIPES may launch, and it must report the recipe's mode over ACP. */
export function permissionLaunch(kind: string, parent: string | undefined, runId: string, command: HarnessCommand): Verified | null {
  if (parent && command.ceiling?.profile === parent) return { ...command, ceiling: command.ceiling };
  const recipe = Object.hasOwn(ASK_RECIPES, kind) ? ASK_RECIPES[kind]! : null;
  if (!recipe || (parent !== undefined && !ASK_PROFILES.has(parent))) return null;
  const { mode, env, ...rest } = recipe.launch(command, runId);
  return { ...command, ...rest, askEveryTime: true, ceiling: { profile: recipe.profile, mode }, env: { ...command.env, ...env } };
}
