import { join } from "node:path";
import type { SlashCommand } from "../../shared/protocol.ts";
import type { AgentCommandSource } from "./index.ts";
import { canonicalFile, environValue, walkSkills } from "./walk.ts";

// jcode 0.99.899-dev has no pinned slash-command table here: its TUI palette is built in code
// rather than a registry a scan can be checked against, so only skills are listed. They are the
// ones crates/jcode-base/src/skill.rs loads: `<root>/<name>/SKILL.md`, name and description from
// the frontmatter, the folder's name when the frontmatter has none.
const rules = { depth: "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: true } as const;

/**
 * Jcode's skills, in the order Jcode resolves a name (later loads win there, so the winner comes
 * first here): the session folder's `.jcode`, `.agents` and `.claude`, then `$JCODE_HOME`'s (or
 * `~/.jcode`'s) `skills`, then `~/.agents/skills` (skill.rs `load_global` and
 * `load_project_local_dirs`). Project skills are resolved against the session's own folder, never a
 * repository root or an ancestor, as Jcode resolves them. A first run copies `~/.claude/skills` and
 * `~/.codex/skills` into `~/.jcode/skills` once, so that store already covers them. Claude Code
 * plugin skills, which Jcode loads below every root here, are left to the Claude source that lists
 * them.
 */
export const source: AgentCommandSource = {
  builtins: [],
  discover({ cwd, home, env }) {
    const found = new Map<string, SlashCommand>();
    const scan = (root: string, origin: SlashCommand["origin"]): void => {
      for (const skill of walkSkills(root, rules)) {
        if (found.has(skill.name)) continue;
        found.set(skill.name, { name: skill.name, description: skill.description, source: "skill", origin, id: canonicalFile(skill.path) });
      }
    };
    // JCODE_HOME names the store beside session-metadata-v1.sqlite3 (jcode-base storage::jcode_dir)
    const jcodeHome = environValue(env, "JCODE_HOME") || join(home, ".jcode");
    if (cwd) {
      scan(join(cwd, ".jcode", "skills"), "project");
      scan(join(cwd, ".agents", "skills"), "project");
      scan(join(cwd, ".claude", "skills"), "project");
    }
    scan(join(jcodeHome, "skills"), "user");
    scan(join(home, ".agents", "skills"), "user");
    return [...found.values()];
  },
};
