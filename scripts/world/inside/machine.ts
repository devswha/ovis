/**
 * Runs inside a world's machine container: `bun /opt/world/inside/machine.ts <command> [args]`.
 *   engine-start [session] | engine-stop [session]   classic herdr's server (a named session too), or herdr-core's core
 *   agent [session]        a stand-in claude with a real transcript and a real prompt screen, in a terminal of the engine
 *   agent-as <tag> <kind> <state>  another stand-in in the default session, named <kind> (claude, codex), reported as <state>
 *   server                 the ordinary Ovis server of the checkout under test, in the foreground
 *   server-file <file> [argv]  a server started from exactly a file of NAME=value lines (m2-trial-server.md, "The start
 *                          line") plus the login's HOME, PATH, SHELL, USER, LANG and XDG_*; argv defaults to the ordinary server
 *   env                    the server's environment as shell exports (term.sh reads it)
 *   hc <args>              hc, isolated (its own session, state, config and runtime folders) or not at all
 * The machine's engine is WORLD_ENGINE (herdr or core). hc is never the user's: it is the binary the world copied in.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuoted } from "./quote.ts";

const HOME = process.env["HOME"] ?? "";
const NAME = process.env["WORLD_MACHINE"] ?? "";
const ENGINE = process.env["WORLD_ENGINE"] === "core" ? "core" : "herdr";
const REPO = process.env["WORLD_REPO"] ?? "/opt/ovis";
const HC_BIN = "/opt/world-bin/hc";
if (!existsSync("/.dockerenv") || !HOME.startsWith("/home/") || NAME === "") throw new Error("machine.ts runs only inside a world's machine container");
const { herdrRpc }: typeof import("../../../server/herdr/client.ts") = await import(`${REPO}/server/herdr/client.ts`);
const { claudeProjectDir }: typeof import("../../../server/claude-store.ts") = await import(`${REPO}/server/claude-store.ts`);

const HC_ROOT = join(HOME, "hc");
const herdrSocket = (session?: string) => session ? join(HOME, ".config/herdr/sessions", session, "herdr.sock") : join(HOME, ".config/herdr/herdr.sock");
const say = (value: unknown) => console.log(JSON.stringify(value));

function hcEnv(): Record<string, string> {
  const isolated: Record<string, string> = {
    HC_SESSION: `world-${NAME}`,
    XDG_STATE_HOME: join(HC_ROOT, "state"), XDG_CONFIG_HOME: join(HC_ROOT, "config"),
    XDG_RUNTIME_DIR: join(HC_ROOT, "run"), HC_SOCKET: join(HC_ROOT, "run", "hc.sock"),
  };
  for (const [key, value] of Object.entries(isolated)) if (key !== "HC_SESSION" && !value.startsWith(HC_ROOT)) throw new Error(`hc refused: ${key} is not isolated`);
  for (const dir of ["state", "config", "run"]) mkdirSync(join(HC_ROOT, dir), { recursive: true, mode: 0o700 });
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !entry[0].startsWith("HC_") && entry[1] !== undefined));
  return { ...inherited, ...isolated };
}

async function hc(args: readonly string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([HC_BIN, ...args], { env: hcEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, out: out + err };
}

export function serverEnv(): Record<string, string> {
  const passes = process.env["WORLD_PASSES"] !== "off";
  const base: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PORT: "17611", HOST: "127.0.0.1", OVIS_STATE_DIR: join(HOME, "ovis-state"), OVIS_TELEMETRY: "0",
    OVIS_RELAY_URL: process.env["WORLD_RELAY_URL"] ?? "",
    // with passes on, WORLD_ACCOUNT_URL is Ovis's staging service name, the one origin for which the server asks the
    // relay for passes (server/relay/service.ts); every name resolves to the world's TLS proxy inside the network only
    OVIS_ACCOUNT_SERVICE_URL: process.env["WORLD_ACCOUNT_URL"] ?? "",
    ...(process.env["WORLD_APP_URL"] ? { OVIS_RELAY_APP_URL: process.env["WORLD_APP_URL"] } : {}),
    ...(passes ? { OVIS_RELAY_STAGING: "1" } : {}),
    NODE_EXTRA_CA_CERTS: "/world/ca.pem", HERDR_SOCKET: herdrSocket(),
  };
  return ENGINE === "core" ? { ...base, ...hcEnv(), OVIS_RUNTIME: "herdr-core", OVIS_HC_BIN: HC_BIN } : base;
}

async function until(what: string, check: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(100);
  }
}

const herdrUp = async (session?: string) => { try { await herdrRpc("ping", {}, herdrSocket(session)); return true; } catch { return false; } };

async function engineStart(session?: string): Promise<void> {
  if (ENGINE === "core") { say({ engine: "core", start: await hc(["server", "start"]), status: (await hc(["server", "status", "--json"])).out.trim() }); return; }
  if (await herdrUp(session)) { say({ engine: "herdr", session: session ?? null, already: true }); return; }
  const log = join(HOME, `herdr-${session ?? "default"}`);
  const child = Bun.spawn(["herdr", ...(session ? ["--session", session] : []), "server"], { env: { ...process.env, HOME }, stdin: "ignore", stdout: Bun.file(`${log}.log`), stderr: Bun.file(`${log}.err`) });
  child.unref();
  await until("herdr server", () => herdrUp(session));
  say({ engine: "herdr", session: session ?? null, pid: child.pid });
}

async function engineStop(session?: string): Promise<void> {
  if (ENGINE === "core") { say({ engine: "core", stop: await hc(["server", "stop"]) }); return; }
  const child = Bun.spawn(["herdr", ...(session ? ["--session", session] : []), "server", "stop"], { env: { ...process.env, HOME }, stdout: "pipe", stderr: "pipe" });
  say({ engine: "herdr", session: session ?? null, stop: await child.exited });
}

const SESSION_ID = "8d8f7d39-6788-49f3-b071-e3ba985c163c";

/** The agent stand-in: a copy of node named claude, its transcript and its trust prompt, answering keys like the real one. */
function standIn(dir: string, tag: string, kind = "claude"): string[] {
  mkdirSync(dir, { recursive: true });
  const project = join(HOME, ".claude/projects", claudeProjectDir(dir));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${SESSION_ID}.jsonl`), [
    { type: "user", message: { content: `Please check ${NAME}.` } },
    { type: "assistant", message: { content: [{ type: "text", text: `The conversation is stored on ${NAME}.` }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(join(dir, `notes-${NAME}.txt`), `A file on ${NAME}.\n`);
  // one copy serves every stand-in: copying over a running one fails (ETXTBSY)
  if (!existsSync(join(HOME, kind))) copyFileSync(Bun.which("node")!, join(HOME, kind));
  const agent = join(HOME, "claude.cjs");
  writeFileSync(agent, `const fs = require("node:fs");
const [home, dir, sessionId, tag, kind] = process.argv.slice(2);
process.title = kind || "claude";
const procStart = fs.readFileSync("/proc/self/stat", "utf8").split(") ").pop().split(" ")[19];
fs.mkdirSync(home + "/.claude/sessions", {recursive:true});
fs.writeFileSync(home + "/.claude/sessions/" + process.pid + ".json", JSON.stringify({pid:process.pid,sessionId,cwd:dir,procStart,kind:"interactive"}));
let cursor=0, waiting=true;
const rows=["No, exit", "Yes, I trust this folder"];
const draw=()=>process.stdout.write("\\x1b[2J\\x1b[H" + (waiting ? [" Accessing workspace:",""," Quick safety check: Is this a project you created or one you trust?","",...rows.map((r,i)=>" "+(i===cursor?"\\u276f":" ")+" "+r),""," Enter to confirm \\u00b7 Esc to cancel"] : ["${NAME} agent answered.","Waiting for the next instruction."]).join("\\r\\n"));
process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on("data",chunk=>{ const text=chunk.toString();fs.appendFileSync(home+"/input-"+tag+".jsonl",JSON.stringify(text)+"\\n");if(text.includes("\\x1b[B"))cursor=Math.min(1,cursor+1);if(text.includes("\\x1b[A"))cursor=Math.max(0,cursor-1);if(text.includes("\\r")){fs.appendFileSync(home+"/answers-"+tag,rows[cursor]+"\\n");waiting=false;}if(text==="r")waiting=true;draw(); });
process.on("SIGUSR1",()=>{fs.appendFileSync(home+"/asks-"+tag,"asked\\n");waiting=true;cursor=0;draw();});
fs.writeFileSync(home+"/ready-"+tag,String(process.pid));draw();
`);
  return [join(HOME, kind), agent, HOME, dir, SESSION_ID, tag, kind];
}

async function agent(session?: string, as?: { readonly tag: string; readonly kind: string; readonly state: string }): Promise<void> {
  const tag = as?.tag ?? session ?? "default";
  const dir = join(HOME, tag === "default" ? "project" : `project-${tag}`);
  const command = standIn(dir, tag, as?.kind);
  const ready = join(HOME, `ready-${tag}`);
  if (ENGINE === "core") {
    // the argv goes to hc as separate words: one quoted string would run under `sh -c` and show as `sh`, not claude
    const ran = await hc(["run", "--bg", "--no-parent", "--name", `agent-${tag}`, "--cwd", dir, "--", ...command]);
    await until("stand-in ready", () => existsSync(ready));
    say({ engine: "core", run: ran, ls: (await hc(["ls", "--json"])).out.trim(), standIn: readFileSync(ready, "utf8") });
    return;
  }
  const socket = herdrSocket(session);
  const made = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", { cwd: dir, label: `${NAME} agent`, focus: false }, socket);
  const pane = made.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `exec ${command.map((part) => JSON.stringify(part)).join(" ")}\n` }, socket);
  await until("stand-in ready", () => existsSync(ready));
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: as?.kind ?? "claude", state: as?.state ?? "blocked" }, socket);
  say({ engine: "herdr", session: session ?? null, pane, workspace: made.workspace.workspace_id, standIn: readFileSync(ready, "utf8") });
}

async function server(): Promise<number> {
  const child = Bun.spawn(["bun", "run", join(REPO, "server/index.ts")], { cwd: REPO, env: serverEnv(), stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  return child.exited;
}

/** NAME=value lines; blank lines and # comments skipped; anything else refused. */
function startLine(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`start line, line ${index + 1}: NAME=value`);
    env[match[1]!] = match[2]!;
  }
  return env;
}

async function serverFromFile(file: string, argv: readonly string[]): Promise<number> {
  const login = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && /^(HOME|PATH|SHELL|USER|LANG|XDG_.*)$/.test(entry[0])));
  const env = { NODE_EXTRA_CA_CERTS: "/world/ca.pem", ...login, ...startLine(readFileSync(file, "utf8")) };
  const child = Bun.spawn(argv.length > 0 ? [...argv] : ["bun", "run", join(REPO, "server/index.ts")], { cwd: argv.length > 0 ? HOME : REPO, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  return child.exited;
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "engine-start": await engineStart(rest[0]); break;
  case "engine-stop": await engineStop(rest[0]); break;
  case "agent": await agent(rest[0]); break;
  // another stand-in in the default session: its own tag, process name (claude, codex) and reported state
  case "agent-as": await agent(undefined, { tag: rest[0] ?? "", kind: rest[1] ?? "claude", state: rest[2] ?? "idle" }); break;
  case "server": process.exitCode = await server(); break;
  case "server-file": process.exitCode = await serverFromFile(rest[0] ?? "", rest.slice(1)); break;
  case "env": console.log(Object.entries(serverEnv()).filter(([key]) => /^(PORT|HOST|OVIS_|HC_|XDG_|HERDR_|NODE_EXTRA)/.test(key)).map(([key, value]) => `export ${key}=${shellQuoted(value)}`).join("\n")); break;
  case "hc": say(await hc(rest)); break;
  default: throw new Error(`unknown command ${command}`);
}
