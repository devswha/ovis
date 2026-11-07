import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalCommand } from "../../src/lib/compose.ts";
import { paneCommands } from "../commands.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "letta-skills-"));
  roots.push(root);
  return root;
}
function skill(directory: string, front: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\n${front}\n---\nBody\n`);
}
const skills = (cwd: string | null, home: string, env: string[] | null = null) =>
  paneCommands("letta", cwd, home, { environ: env }).filter(({ source }) => source === "skill");

it("lists the rows of Letta Code 0.34.41's own menu, with its hidden commands kept typed-only", () => {
  const builtins = paneCommands("letta", null, temp()).filter(({ source }) => source === "builtin");
  const shown = builtins.filter(({ visibility }) => visibility !== "agent-hidden");
  expect(shown).toHaveLength(55);
  for (const name of ["agents", "model", "init", "doctor", "new", "resume", "compact"]) expect(shown.some((command) => command.name === name), name).toBeTrue();
  expect(builtins.filter(({ visibility }) => visibility === "agent-hidden").map(({ name }) => name).sort())
    .toEqual(["cd", "clear-messages", "help", "link", "pinned", "profiles", "reflection", "set-max-context", "stream", "unlink"]);
  expect(builtins.find(({ name }) => name === "new")).toMatchObject({ description: "Start a new conversation (keep agent memory)", provenance: { transport: "static" } });
});

it("puts only the commands that open one of Letta's own screens under Terminal commands", () => {
  const byName = new Map(paneCommands("letta", null, temp()).map((command) => [command.name, command]));
  for (const name of ["agents", "model", "skills", "memory", "resume", "connect", "login"]) expect(terminalCommand(byName.get(name)!), name).toBeTrue();
  for (const name of ["new", "clear", "compact", "init", "fork", "usage", "context", "doctor"]) expect(terminalCommand(byName.get(name)!), name).toBeFalse();
  // a value given to a picker command is not the picker: /resume <id> resumes
  expect(byName.get("resume")!.forms).toEqual([{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "unknown" }]);
});

it("lists the user's and the project's skills by Letta's names, the project's winning, without the hidden ones", () => {
  const home = temp(), cwd = join(home, "project");
  skill(join(home, ".letta", "skills", "review"), "name: review\ndescription: user review");
  skill(join(home, ".letta", "skills", "web", "scraper"), "description: nested, named by its folder");
  skill(join(home, ".letta", "skills", "quiet"), "name: quiet\ndescription: model only\nuser-invocable: false");
  skill(join(home, ".letta", "skills", "clash"), "name: model\ndescription: named like a builtin");
  skill(join(cwd, ".agents", "skills", "review"), "name: review\ndescription: project review");
  const found = skills(cwd, home);
  expect(found.map(({ name, origin }) => `${name}:${origin}`).sort()).toEqual(["review:project", "web/scraper:user"]);
  expect(found.find(({ name }) => name === "review")!.description).toBe("project review");
  // LETTA_CONFIG_DIR moves the user's folder
  const config = join(home, "elsewhere");
  skill(join(config, "skills", "moved"), "name: moved\ndescription: from the config dir");
  expect(skills(null, home, [`LETTA_CONFIG_DIR=${config}`]).map(({ name }) => name)).toEqual(["moved"]);
});
