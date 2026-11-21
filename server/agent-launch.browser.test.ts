import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetBuiltInBrowserToken, keepBuiltInBrowserTokens, moveBuiltInBrowserToken, readBrowserToolSetting, withBrowserTool } from "./agent-launch.ts";

const dirs: string[] = [];
afterEach(() => {
  setSystemTime();
  readBrowserToolSetting(() => undefined, tmpdir(), null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function host(enabled: boolean, socketAt: string | null | "missing" = "made") {
  const dir = mkdtempSync(join(tmpdir(), "ovis-builtin-tool-"));
  dirs.push(dir);
  // the app's socket stands in as a file where the app would have made it
  const socket = socketAt === null ? null : join(dir, "broker.sock");
  if (socketAt === "made") writeFileSync(join(dir, "broker.sock"), "");
  const tokensDir = join(dir, "browser-tokens");
  readBrowserToolSetting(() => ({ claude: "ovis", codex: "ovis" }), join(dir, "browser tools"), { socket, enabled: () => enabled, tokensDir, command: ["/opt/ovis/ovis-server", "browser-mcp"] });
  return { dir, tokensDir };
}

/** the token file an agent was given, read from its MCP config */
function tokenOf(args: string[]): string {
  const config = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1]!, "utf8"));
  const given: string[] = config.mcpServers["ovis-browser"].args;
  return given[given.indexOf("--token-file") + 1]!;
}

/** the pane that owns a token now */
const ownerOf = (token: string) => readFileSync(token.replace(/\.token$/, ".pane"), "utf8");

describe("the built-in browser as an agent's browser tool", () => {
  it("gives a pane's agent its own token and the app's socket, and takes the token back when the pane goes", () => {
    const { dir, tokensDir } = host(true);
    const args = withBrowserTool("claude", ["--model", "opus"], "linux", "p7")!;
    expect(args.slice(0, 3)).toEqual(["--model", "opus", "--mcp-config"]);
    const token = tokenOf(args);
    expect(token.startsWith(tokensDir)).toBe(true);
    expect(args[3]).toBe(join(dir, "browser tools", `claude-ovis-${token.slice(tokensDir.length + 1, -".token".length)}.json`));
    const config = JSON.parse(readFileSync(args[3]!, "utf8"));
    expect(config.mcpServers["ovis-browser"]).toEqual({ type: "stdio", command: "/opt/ovis/ovis-server", args: ["browser-mcp", "--socket", join(dir, "broker.sock"), "--token-file", token] });
    if (process.platform !== "win32") expect(statSync(token).mode & 0o777).toBe(0o600);
    expect(readFileSync(token, "utf8")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ownerOf(token)).toBe("p7");
    // started anew: a new key, and the old token and its config are gone
    const again = withBrowserTool("claude", [], "linux", "p7")!;
    expect(tokenOf(again)).not.toBe(token);
    expect(existsSync(token)).toBe(false);
    expect(existsSync(args[3]!)).toBe(false);
    const againToken = tokenOf(again);
    forgetBuiltInBrowserToken("p7");
    expect(existsSync(againToken)).toBe(false);
    expect(existsSync(again[again.indexOf("--mcp-config") + 1]!)).toBe(false);
  });

  it("passes Codex the same as -c settings", () => {
    const { dir, tokensDir } = host(true);
    const args = withBrowserTool("codex", ["--", "do it"], "linux", "p8")!;
    expect(args[0]).toBe("-c");
    expect(args[1]).toBe("mcp_servers.ovis-browser.command='/opt/ovis/ovis-server'");
    expect(args[3]).toMatch(new RegExp(`^mcp_servers\\.ovis-browser\\.args=\\['browser-mcp','--socket','${join(dir, "broker.sock").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}','--token-file','${tokensDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[0-9a-f]{32}\\.token'\\]$`));
    expect(args.slice(4)).toEqual(["--", "do it"]);
  });

  it("adds nothing while the setting is off, outside the desktop app, or without a pane", () => {
    // each host's own token folder stays unmade: nothing was issued there, nor next to it
    const off = host(false);
    expect(withBrowserTool("claude", ["--x"], "linux", "p1")).toEqual(["--x"]);
    const outside = host(true, null);
    expect(withBrowserTool("claude", ["--x"], "linux", "p1")).toEqual(["--x"]);
    const paneless = host(true);
    expect(withBrowserTool("claude", ["--x"], "linux")).toEqual(["--x"]);
    expect(withBrowserTool("claude", ["--x"], "linux", "../p1")).toEqual(["--x"]);
    for (const { dir, tokensDir } of [off, outside, paneless]) {
      expect(existsSync(tokensDir)).toBe(false);
      expect(readdirSync(dir).filter((name) => name !== "broker.sock")).toEqual([]);
    }
  });

  it("starts the agent without the tool, and writes no token, when the app's socket is not there", () => {
    const { tokensDir } = host(true, "missing");
    expect(withBrowserTool("claude", ["--model", "opus"], "linux", "p9")).toEqual(["--model", "opus"]);
    expect(existsSync(tokensDir)).toBe(false);
  });

  it("takes back the tokens of panes a snapshot no longer lists, but not one issued or moved after it was asked for", () => {
    const { tokensDir } = host(true);
    setSystemTime(new Date(1_000));
    const kept = tokenOf(withBrowserTool("claude", [], "linux", "kept")!);
    const gone = tokenOf(withBrowserTool("claude", [], "linux", "gone")!);
    const moving = tokenOf(withBrowserTool("claude", [], "linux", "moving")!);
    writeFileSync(join(tokensDir, "nobody.token"), "x".repeat(43));
    setSystemTime(new Date(2_000));
    const askedAt = Date.now();
    // in the same millisecond as the asking, and later: newer than the snapshot
    const late = tokenOf(withBrowserTool("claude", [], "linux", "late")!);
    moveBuiltInBrowserToken("moving", "moved");
    keepBuiltInBrowserTokens(new Set(["kept"]), askedAt);
    expect([existsSync(kept), existsSync(gone), existsSync(late), existsSync(moving), existsSync(join(tokensDir, "nobody.token"))]).toEqual([true, false, true, true, false]);
  });

  it("takes back, after a restart, the tokens of panes that ended meanwhile", () => {
    const { tokensDir } = host(true);
    // left by the server before this one, which this one never issued: older than its first snapshot
    mkdirSync(tokensDir, { recursive: true });
    for (const [key, pane] of [["k-ended", "ended"], ["k-live", "live"]] as const) {
      writeFileSync(join(tokensDir, `${key}.token`), "x".repeat(43));
      writeFileSync(join(tokensDir, `${key}.pane`), pane);
    }
    keepBuiltInBrowserTokens(new Set(["live"]), Date.now());
    expect([existsSync(join(tokensDir, "k-ended.token")), existsSync(join(tokensDir, "k-ended.pane")), existsSync(join(tokensDir, "k-live.token"))]).toEqual([false, false, true]);
  });

  it("keeps a moved pane's agent on its token, so a later pane given the old id never meets it", () => {
    host(true);
    const moved = tokenOf(withBrowserTool("claude", [], "linux", "w1-p1")!);
    moveBuiltInBrowserToken("w1-p1", "w2-p1");
    expect(ownerOf(moved)).toBe("w2-p1");
    const reused = tokenOf(withBrowserTool("claude", [], "linux", "w1-p1")!);
    expect(reused).not.toBe(moved);
    expect([existsSync(moved), ownerOf(reused)]).toEqual([true, "w1-p1"]);
    keepBuiltInBrowserTokens(new Set(["w2-p1", "w1-p1"]), Date.now() + 1000);
    expect(existsSync(moved)).toBe(true);
  });
});
