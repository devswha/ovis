import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneCommands } from "../commands.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "jcode-skills-"));
  roots.push(root);
  return root;
}
function put(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
function skill(path: string, fields = "description: Probe skill. More detail.\n"): void {
  put(join(path, "SKILL.md"), `---\n${fields}---\nProbe body\n`);
}
const skills = (cwd: string, home: string, environ?: readonly string[]) =>
  paneCommands("jcode", cwd, home, environ ? { environ } : {}).filter(({ source }) => source === "skill");
const rows = (cwd: string, home: string, environ?: readonly string[]) =>
  skills(cwd, home, environ).map(({ name, origin }) => [name, origin]);

it("lists no builtins: jcode's palette is code, not a scannable registry", () => {
  const home = temp();
  expect(paneCommands("jcode", home, home).filter(({ source }) => source !== "skill")).toEqual([]);
});

it("resolves a name the way jcode does: the session folder, then the user's stores", () => {
  const home = temp(), cwd = join(home, "repo", "sub");
  skill(join(cwd, ".jcode", "skills", "jcode-local"));
  skill(join(cwd, ".agents", "skills", "agents-local"));
  skill(join(cwd, ".claude", "skills", "claude-local"));
  skill(join(cwd, ".jcode", "skills", "collision"));
  skill(join(cwd, ".agents", "skills", "collision"));
  skill(join(cwd, ".claude", "skills", "collision"));
  skill(join(home, ".jcode", "skills", "personal"));
  skill(join(home, ".jcode", "skills", "collision"));
  skill(join(home, ".agents", "skills", "shared"));
  skill(join(home, ".agents", "skills", "collision"));
  expect(skills(cwd, home).map(({ name, origin, description }) => [name, origin, description])).toEqual([
    ["agents-local", "project", "Probe skill. More detail."], ["claude-local", "project", "Probe skill. More detail."],
    ["collision", "project", "Probe skill. More detail."], ["jcode-local", "project", "Probe skill. More detail."],
    ["personal", "user", "Probe skill. More detail."], ["shared", "user", "Probe skill. More detail."],
  ]);
});

it("reads the session folder only: a skill above it is not a jcode skill", () => {
  const home = temp(), cwd = join(home, "repo", "sub");
  put(join(home, "repo", ".git"), "gitdir: fixture");
  skill(join(home, "repo", ".jcode", "skills", "root-only"));
  skill(join(cwd, ".jcode", "skills", "here"));
  expect(rows(cwd, home)).toEqual([["here", "project"]]);
});

it("takes JCODE_HOME as the store beside the session index, and ~/.jcode by default", () => {
  const home = temp(), store = join(home, "store"), cwd = join(home, "repo");
  skill(join(store, "skills", "from-store"));
  skill(join(home, ".jcode", "skills", "from-home"));
  expect(rows(cwd, home)).toEqual([["from-home", "user"]]);
  expect(rows(cwd, home, [`JCODE_HOME=${store}`])).toEqual([["from-store", "user"]]);
  expect(rows(cwd, home, ["JCODE_HOME="])).toEqual([["from-home", "user"]]);
});

it("requires a SKILL.md with a description, and names a skill from its frontmatter or its folder", () => {
  const home = temp(), cwd = join(home, "repo"), root = join(cwd, ".jcode", "skills");
  skill(join(root, "folder-name"), "name: frontmatter-name\ndescription: Named by frontmatter.\n");
  skill(join(root, "described"), "description: Named by its folder.\n");
  skill(join(root, "undescribed"), "name: undescribed\n");
  put(join(root, "loose.md"), "---\ndescription: Not a skill.\n---\nbody\n");
  put(join(root, "nested", "deeper", "SKILL.md"), "---\ndescription: Too deep.\n---\nbody\n");
  put(join(root, "flat", "notes.md"), "---\ndescription: No SKILL.md.\n---\nbody\n");
  expect(rows(cwd, home)).toEqual([["described", "project"], ["frontmatter-name", "project"]]);
});
