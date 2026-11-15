/** Compiled classic bridge + existing Ovis on one isolated herdr, through a controller's real fleet forward.
 * Run inside the CI runner with OVIS_QA_SERVER naming the staged compiled server (verified bin/ host beside it).
 * UI_EVIDENCE_DIR retains HTTP transcripts, socket actions, timings and screenshots. No paid agent or owner state.
 */
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDir } from "../server/claude-store.ts";
import { herdrRpc, sessionSnapshot } from "../server/herdr/client.ts";
import { fleetTestServer, FLEET_TEST_TOKEN } from "../server/fleet/test-server.ts";
import { advertFrame, machineConnection, machineKey, pipeToTarget, testAdvert } from "../server/fleet/test-helpers.ts";
import { bounded } from "../server/relay/test-helpers.ts";
import { loadRelayIdentity } from "../server/relay/identity.ts";
import { chromePath } from "./chrome-path.ts";
import { chromium } from "playwright-core";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { paneStorageId } from "../shared/machines.ts";

const binary = process.env["OVIS_QA_SERVER"];
const evidence = process.env["UI_EVIDENCE_DIR"];
if (!binary || !evidence) throw new Error("Set OVIS_QA_SERVER and UI_EVIDENCE_DIR for the isolated container QA");
mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "fleet-real-"));
const home = join(root, "home");
mkdirSync(home);
const config = join(home, ".config");
const socket = join(config, "herdr/sessions/fleet-qa/herdr.sock");
const fleetState = join(home, "fleet/state");
const ownState = join(config, "ovis");
const id = loadRelayIdentity(ownState).server_id;
const baseEnv: Record<string, string> = {
  HOME: home, USER: process.env["USER"] || "runner", SHELL: "/bin/bash", PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: tmpdir(),
  XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(home, ".local/state"), HOST: "127.0.0.1", PORT: "0", OVIS_HERDR_BIN: Bun.which("herdr")!,
  HERDR_SOCKET: socket, HERDR_TEST_SESSION: "fleet-qa", OVIS_RUNTIME: "herdr", OVIS_ASSETS: process.cwd(),
};
const children: ReturnType<typeof Bun.spawn>[] = [];
const actions = join(evidence, "actions.jsonl");
const note = (entry: unknown) => appendFileSync(actions, JSON.stringify({ at: Date.now(), entry }) + "\n");
// The contract runs four phases, each with its own deadline. A stalled RPC or pipe
// names its phase and current wait before the parent's overall child budget expires.
const earlyOnly = process.env["OVIS_QA_EARLY_ONLY"] === "1";
const phaseMs = Number(process.env["OVIS_QA_PHASE_MS"] || 20_000);
const expired = Promise.withResolvers<never>();
let phaseTimer: ReturnType<typeof setTimeout> | undefined;
let cancelled: Error | undefined;
let waitingFor = "fixture setup";
function phase(name: string): void {
  if (cancelled) throw cancelled;
  if (!earlyOnly) return;
  clearTimeout(phaseTimer);
  note({ phase: name, budget_ms: phaseMs });
  phaseTimer = setTimeout(() => {
    cancelled = new Error(`Timed out: ${name}, waiting for ${waitingFor} (${phaseMs} ms phase budget)`);
    expired.reject(cancelled);
  }, phaseMs);
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 20_000): Promise<void> {
  waitingFor = label;
  const deadline = Date.now() + timeout;
  while (true) {
    if (cancelled) throw cancelled;
    const matched = await check();
    if (cancelled) throw cancelled;
    if (matched) return;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(25);
  }
}
function start(name: string, args: string[], env: Record<string, string>) {
  if (cancelled) throw cancelled;
  note({ surface: "CLI", name, invocation: ["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...args] });
  const fd = openSync(join(evidence, name + ".log"), "w");
  const child = Bun.spawn(args, { env, stdin: "ignore", stdout: fd, stderr: fd });
  closeSync(fd);
  children.push(child);
  return child;
}
/** Identify only the attach process below a fixture server, then measure its actual retirement. */
async function attachPid(parent: number): Promise<number> {
  const ps = Bun.spawn(["ps", "-eo", "pid=,ppid=,args="], { env: process.env, stdin: "ignore", stdout: "pipe" });
  const rows = (await new Response(ps.stdout).text()).trim().split("\n").map((line) => {
    const fields = line.trim().split(/\s+/); return { pid: Number(fields[0]), parent: Number(fields[1]), args: fields.slice(2).join(" ") };
  });
  assert.equal(await ps.exited, 0);
  const host = rows.find((row) => row.parent === parent && (row.args.includes("ovis-pty-sidecar") || row.args.includes("pty-host.mjs")));
  assert.ok(host, `PTY host below ${parent}`);
  const attach = rows.find((row) => row.parent === host.pid && row.args.includes("terminal attach"));
  assert.ok(attach, "herdr attach below the fixture's PTY host");
  assert.ok(!attach.args.includes("--takeover"), "no automatic takeover");
  note({ surface: "OS process tree", server: parent, host: host.pid, attach: attach.pid });
  return attach.pid;
}
const rpc = <T = unknown>(method: string, params: Record<string, unknown> = {}) => {
  waitingFor = `herdr ${method}`;
  return herdrRpc<T>(method, params, socket);
};
interface Descriptor { port: number; token: string; bridge_port: number; bridge_token: string; runtime_id: string; boot_id: string; runtime_down: boolean; versions: { server: string; agent: string; runtime: string } }
const readAdvert = () => JSON.parse(readFileSync(join(fleetState, "advert.json"), "utf8")) as Descriptor;
const fixture = fleetTestServer({ stateDir: join(root, "controller"), machines: true });
const fleet = fixture.app.context.services.relay.fleet;
const connections: WebSocket[] = [];
let machine: Awaited<ReturnType<typeof machineConnection>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const results: Record<string, unknown> = {};

function viewer(port: number, token: string, pane: string, label: string, machineId?: string) {
  const url = `ws://127.0.0.1:${port}/ws${machineId ? `?machine_id=${machineId}` : ""}`;
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  connections.push(ws);
  const frames: ServerMessage[] = [];
  ws.addEventListener("message", (event) => { const frame = JSON.parse(String(event.data)) as ServerMessage; frames.push(frame); note({ surface: "WebSocket", label, received: frame }); });
  const send = (frame: ClientMessage) => { note({ surface: "WebSocket", label, sent: frame }); ws.send(JSON.stringify(frame)); };
  const wait = (check: (frame: ServerMessage) => boolean, from = 0) => until(() => frames.slice(from).some(check), `${label} frame`, 20_000);
  return { ws, frames, send, wait, open: until(() => ws.readyState === WebSocket.OPEN, `${label} open`), pane };
}
async function curl(label: string, port: number, token: string, route: string, body?: unknown) {
  waitingFor = label;
  const args = ["curl", "-i", "-sS", "--max-time", "15", "-H", `Authorization: Bearer ${token}`, ...(body === undefined ? [] : ["-H", "Content-Type: application/json", "--data", JSON.stringify(body)]), `http://127.0.0.1:${port}${route}`];
  note({ surface: "HTTP", label, invocation: args });
  const proc = Bun.spawn(args, { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const text = await new Response(proc.stdout).text();
  writeFileSync(join(evidence, label + ".http.txt"), text);
  assert.equal(await proc.exited, 0);
  assert.match(text, /^HTTP\/1\.1 200/);
  return JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4));
}

async function run(): Promise<void> {
  phase("fixture startup");
  const controllerHome = join(root, "controller-home");
  mkdirSync(controllerHome);
  const controllerConfig = join(controllerHome, "config");
  const controllerSocket = join(controllerConfig, "herdr/sessions/fleet-controller/herdr.sock");
  process.env["HERDR_SOCKET"] = controllerSocket;
  start("controller-herdr", [baseEnv.OVIS_HERDR_BIN!, "--session", "fleet-controller", "server"], {
    ...baseEnv, HOME: controllerHome, XDG_CONFIG_HOME: controllerConfig, HERDR_SOCKET: controllerSocket, HERDR_TEST_SESSION: "fleet-controller",
  });
  await until(async () => { try { await herdrRpc("ping", {}, controllerSocket); return true; } catch { return false; } }, "controller engine");
  const agentBin = join(home, "login-only");
  mkdirSync(agentBin);
  writeFileSync(join(agentBin, "gjc"), "#!/bin/sh\nprintf 'gjc 9.9.9\\n'\n");
  chmodSync(join(agentBin, "gjc"), 0o755);
  for (const file of [".bashrc", ".bash_profile"]) writeFileSync(join(home, file), `export PATH=${JSON.stringify(agentBin)}:$PATH\n`);
  let engine = start("herdr", [baseEnv.OVIS_HERDR_BIN!, "--session", "fleet-qa", "server"], baseEnv);
  await until(async () => { try { await rpc("ping"); return true; } catch { return false; } }, "isolated engine");
  const made = await rpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", { cwd: home, label: "Fleet agent", focus: false });
  const pane = made.root_pane.pane_id;
  const other = await rpc<{ root_pane: { pane_id: string } }>("workspace.create", { cwd: home, label: "Other pane", focus: false });
  const sessionId = "8d8f7d39-6788-49f3-b071-e3ba985c163c";
  const project = join(home, ".claude/projects", claudeProjectDir(home));
  mkdirSync(project, { recursive: true });
  const transcript = join(project, sessionId + ".jsonl");
  writeFileSync(transcript, [
    { type: "user", message: { content: "Please verify this fleet machine." } },
    { type: "assistant", message: { content: [{ type: "text", text: "The conversation is stored on the fleet machine." }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  copyFileSync(Bun.which("node")!, join(home, "claude"));
  const agent = join(home, "claude.cjs");
  writeFileSync(agent, `const fs = require("node:fs");
const [home, sessionId] = process.argv.slice(2);
process.title = "claude";
const procStart = fs.readFileSync("/proc/self/stat", "utf8").split(") ").pop().split(" ")[19];
fs.mkdirSync(home + "/.claude/sessions", {recursive:true});
fs.writeFileSync(home + "/.claude/sessions/" + process.pid + ".json", JSON.stringify({pid:process.pid,sessionId,cwd:home,procStart,kind:"interactive"}));
let cursor=0;
let waiting=true;
const rows=["No, exit", "Yes, I trust this folder"];
const draw=()=>process.stdout.write("\\x1b[2J\\x1b[H" + (waiting ? [" Accessing workspace:",""," Quick safety check: Is this a project you created or one you trust?","",...rows.map((r,i)=>" "+(i===cursor?"\u276f":" ")+" "+r),""," Enter to confirm \u00b7 Esc to cancel"] : ["Fleet agent answered.","Waiting for the next instruction."]).join("\\r\\n"));
process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on("data",chunk=>{ const text=chunk.toString();fs.appendFileSync(home+"/input.jsonl",JSON.stringify(text)+"\\n");if(text.includes("\\x1b[B"))cursor=Math.min(1,cursor+1);if(text.includes("\\x1b[A"))cursor=Math.max(0,cursor-1);if(text.includes("\\r")){fs.appendFileSync(home+"/answers",rows[cursor]+"\\n");waiting=false;}if(text==="r")waiting=true;draw(); });
process.stdout.on("resize",()=>fs.appendFileSync(home+"/sizes",process.stdout.columns+"x"+process.stdout.rows+"\\n"));
fs.writeFileSync(home+"/input.jsonl","");fs.writeFileSync(home+"/answers","");fs.writeFileSync(home+"/ready",String(process.pid));draw();
`);
  await rpc("pane.send_text", { pane_id: pane, text: `exec ${JSON.stringify(join(home, "claude"))} ${JSON.stringify(agent)} ${JSON.stringify(home)} ${sessionId}\n` });
  await until(() => existsSync(join(home, "ready")), "stand-in ready");
  await rpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "blocked" });
  const own = start("own-ovis", [binary, "serve"], { ...baseEnv, OVIS_STATE_DIR: ownState });
  const registry = join(home, ".config/herdr-web-ui/bridges");
  let ownDescriptor: Descriptor | undefined;
  await until(() => {
    if (!existsSync(registry)) return false;
    const path = readdirSync(registry).find((name) => name.endsWith(".json"));
    if (!path) return false;
    ownDescriptor = JSON.parse(readFileSync(join(registry, path), "utf8")) as Descriptor;
    return true;
  }, "own Ovis descriptor");
  const fleetEnv = { ...baseEnv, OVIS_FLEET_BRIDGE: "1", OVIS_FLEET_HOME: join(home, "fleet"), OVIS_FLEET_STATE: fleetState, HERDR_REMOTE_SOCKET: socket };
  let bridge = start("fleet-bridge", [binary, "remote"], fleetEnv);
  await until(() => existsSync(join(fleetState, "advert.json")), "fleet advert");
  const advert = readAdvert();
  assert.equal(advert.runtime_id, id);
  const health = await curl("fleet-health", advert.bridge_port, advert.bridge_token, "/api/health");
  assert.equal(health.herdr.terminal_attach, true);
  // The disk advert deliberately uses bridge_*; descriptors use port/token.
  const endpoint = { port: advert.bridge_port, token: advert.bridge_token };
  if (process.env["OVIS_QA_EARLY_ONLY"] !== "1") {
    const missing = join(root, "missing-host");
    mkdirSync(missing);
    copyFileSync(binary, join(missing, "ovis-server"));
    const state = join(missing, "state");
    const mirrored = start("missing-host", [join(missing, "ovis-server"), "remote"], { ...fleetEnv, OVIS_FLEET_HOME: missing, OVIS_FLEET_STATE: state });
    await until(() => existsSync(join(state, "advert.json")), "mirror advert");
    const endpoint = JSON.parse(readFileSync(join(state, "advert.json"), "utf8")) as Descriptor;
    const health = await curl("missing-host-health", endpoint.bridge_port, endpoint.bridge_token, "/api/health");
    assert.equal(health.herdr.terminal_attach, false);
    assert.equal(health.herdr.terminal_mirror, true);
    mirrored.kill(); await mirrored.exited;
    results.mirror_without_host = true;
  }
  fleet.start();
  const key = await machineKey();
  fleet.store.add({ machine_id: key.id, public_key: key.spki, name: "Fleet machine" });
  fleet.store.setState(key.id, "active");
  machine = await machineConnection(fixture, fleet, { machineSessions: fleet }, { onPipe: (pipe) => pipeToTarget(pipe, endpoint.port) });
  await machine.hello(); await machine.signIn(key);
  machine.mux.enqueueControl(advertFrame({ ...testAdvert(["bridge"]), runtime_id: advert.runtime_id, boot_id: advert.boot_id, bridge_token: endpoint.token, versions: { ...advert.versions, link: "test" } }));
  await bounded(machine.mux.measure());
  const publish = async () => {
    const disk = readAdvert();
    endpoint.port = disk.bridge_port; endpoint.token = disk.bridge_token;
    let up = false;
    try { up = (await fetch(`http://127.0.0.1:${endpoint.port}/api/health?scope=bridge`, { headers: { authorization: `Bearer ${endpoint.token}` } })).ok; } catch { /* this real probe observed the stopped bridge */ }
    machine!.mux.enqueueControl(advertFrame({ ...testAdvert(["bridge"]), runtime_id: disk.runtime_id, boot_id: disk.boot_id, bridge_token: disk.bridge_token,
      health: { bridge: up ? "up" : "down", runtime: disk.runtime_down ? "down" : "up" }, versions: { ...disk.versions, link: "test" } }));
    await bounded(machine!.mux.measure());
  };
  const machineId = `fleet-${key.id}`;
  await until(() => fixture.app.context.services.core.machines?.list().some((row) => row.id === machineId && row.state === "connected") ?? false, "controller machine connected");
  const route = `/api/machines/${machineId}`;
  results.identity = { runtime_id: advert.runtime_id, own_server_id: id, boot_id: advert.boot_id };
  phase("own to fleet handover");
  const first = viewer(ownDescriptor!.port, ownDescriptor!.token, pane, "own-first");
  await first.open;
  first.send({ type: "attach", pane_id: pane, cols: 100, rows: 30 });
  await first.wait((f) => f.type === "pty-data");
  const second = viewer(fixture.app.port, FLEET_TEST_TOKEN, pane, "fleet-second", machineId);
  await second.open;
  second.send({ type: "attach", pane_id: pane, cols: 70, rows: 20 });
  await second.wait((f) => f.type === "error" && f.code === "attach_held");
  const beforeInput = readFileSync(join(home, "input.jsonl"), "utf8");
  const beforeSizes = existsSync(join(home, "sizes")) ? readFileSync(join(home, "sizes"), "utf8") : "";
  second.send({ type: "input", pane_id: pane, text: "must-not-arrive" });
  second.send({ type: "keys", pane_id: pane, keys: ["Enter"] });
  second.send({ type: "resize", pane_id: pane, cols: 71, rows: 21 });
  second.send({ type: "submit", id: 1, pane_id: pane, text: "must not type", payload: "must not type" });
  await second.wait((f) => f.type === "submit-result" && !f.ok && f.code === "attach_held");
  const conversation = await curl("held-conversation", fixture.app.port, FLEET_TEST_TOKEN, `${route}/pane/conversation?pane_id=${encodeURIComponent(pane)}`);
  assert.equal(conversation.source, "claude-transcript");
  assert.match(JSON.stringify(conversation), /The conversation is stored on the fleet machine/);
  const prompt = await curl("held-prompt", fixture.app.port, FLEET_TEST_TOKEN, `${route}/pane/prompt?pane_id=${encodeURIComponent(pane)}`);
  assert.ok(prompt.prompt?.options.some((option: { label: string }) => option.label === "Yes, I trust this folder"));
  const snapshot = await curl("held-session", fixture.app.port, FLEET_TEST_TOKEN, `${route}/session`);
  assert.ok(snapshot.snapshot.panes.some((p: { pane_id: string }) => p.pane_id === pane));
  assert.equal(readFileSync(join(home, "input.jsonl"), "utf8"), beforeInput);
  assert.equal(existsSync(join(home, "sizes")) ? readFileSync(join(home, "sizes"), "utf8") : "", beforeSizes);
  const statusesFrom = second.frames.length;
  await rpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "working" });
  await second.wait((f) => f.type === "pane-status" && f.agent_status === "working", statusesFrom);
  await rpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "blocked" });
  const catalog = await curl("bare-login-catalog", endpoint.port, endpoint.token, "/api/agent-catalog?recheck=1");
  assert.equal(catalog.agents.find((entry: { id: string }) => entry.id === "gjc")?.state.installed, true);
  results.bare_login = true;
  const ownAttach = await attachPid(own.pid);
  const left = performance.now();
  first.ws.close();
  await until(() => !existsSync(`/proc/${ownAttach}`), "own attach process released");
  const ownReleased = performance.now() - left;
  await second.wait((f) => f.type === "attach-resumed");
  const resumed = performance.now() - left;
  results.own_then_fleet = { release_upper_bound_ms: ownReleased, delay_ms: resumed, chat: true, prompt: true, listing: true, held_submit_refused: true };
  console.log("COEXISTENCE own -> fleet", JSON.stringify(results.own_then_fleet));
  second.send({ type: "resize", pane_id: pane, cols: 111, rows: 33 });
  await until(() => existsSync(join(home, "sizes")) && readFileSync(join(home, "sizes"), "utf8").includes("111x33"), "live resize through controller");
  second.send({ type: "input", pane_id: pane, text: "z" });
  await until(() => readFileSync(join(home, "input.jsonl"), "utf8").includes('"z"'), "live typing through controller");
  results.live_terminal = { typed: "z", resized: "111x33", held_input_and_resize_refused: true, held_status_read: true };
  phase("fleet to own handover");
  const third = viewer(ownDescriptor!.port, ownDescriptor!.token, pane, "own-second");
  await third.open;
  third.send({ type: "attach", pane_id: pane, cols: 100, rows: 30 });
  await third.wait((f) => f.type === "error" && f.code === "attach_held");
  const fleetAttach = await attachPid(bridge.pid);
  const otherLeft = performance.now();
  second.ws.close();
  await until(() => !existsSync(`/proc/${fleetAttach}`), "fleet attach process released");
  const fleetReleased = performance.now() - otherLeft;
  await third.wait((f) => f.type === "attach-resumed");
  results.fleet_then_own = { release_upper_bound_ms: fleetReleased, delay_ms: performance.now() - otherLeft };
  third.ws.close();
  assert.equal(own.exitCode, null); assert.equal(bridge.exitCode, null);
  writeFileSync(join(evidence, "coexistence.json"), JSON.stringify(results, null, 2));
  console.log("COEXISTENCE PASS", JSON.stringify(results));
  if (earlyOnly) {
    phase("prompt answer");
    const card = await curl("current-prompt", endpoint.port, endpoint.token, `/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`);
    await curl("prompt-answer", endpoint.port, endpoint.token, "/api/pane/prompt/answer", { pane_id: pane, prompt_id: card.prompt.id, option_index: 1 });
    await until(() => readFileSync(join(home, "answers"), "utf8").includes("Yes, I trust this folder"), "HTTP prompt answer reaches the fixture");
    results.prompt_answer = true;
  }
  else {
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US" });
      await context.request.post(`http://127.0.0.1:${fixture.app.port}/api/auth`, { data: { token: FLEET_TEST_TOKEN } });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      page.on("pageerror", (error) => note({ pageerror: error.message }));
      await page.addInitScript((key) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
        localStorage.setItem(`ovis:view:${key}`, "chat");
      }, paneStorageId(machineId, pane));
      note({ surface: "browser", width, invocation: `goto http://127.0.0.1:${fixture.app.port}/?machine=${machineId}&pane=${encodeURIComponent(pane)}; click Chat` });
      await page.goto(`http://127.0.0.1:${fixture.app.port}/?machine=${machineId}&pane=${encodeURIComponent(pane)}`);
      await page.screenshot({ path: join(evidence, `initial-${width}.png`) });
      await page.getByRole("log").getByText("The conversation is stored on the fleet machine.", { exact: true }).waitFor();
      await page.screenshot({ path: join(evidence, `chat-${width}.png`) });
      const sidebar = page.getByRole("region", { name: "PC Fleet machine", exact: true });
      if (width === 390) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await sidebar.locator('[data-status="blocked"]').first().waitFor({ state: "attached" });
      if (width === 390) await page.waitForFunction(() => Math.abs(document.querySelector(".sidebar.is-open")!.getBoundingClientRect().x) < 1);
      await page.screenshot({ path: join(evidence, `sidebar-waiting-${width}.png`) });
      if (width === 390) await page.keyboard.press("Escape");
      const answered = page.waitForResponse((response) => response.url().endsWith("/pane/prompt/answer"));
      const beforeAnswers = readFileSync(join(home, "answers"), "utf8").length;
      await page.getByRole("button", { name: /Yes, I trust this folder/ }).click();
      await until(() => readFileSync(join(home, "answers"), "utf8").length > beforeAnswers, "prompt button reaches agent");
      assert.ok(readFileSync(join(home, "answers"), "utf8").endsWith("Yes, I trust this folder\n"));
      await rpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
      assert.equal((await answered).status(), 200);
      await page.getByRole("button", { name: /Yes, I trust this folder/ }).waitFor({ state: "detached" });
      await page.screenshot({ path: join(evidence, `answered-${width}.png`) });
      await rpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "working" });
      if (width === 390) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await sidebar.locator('[data-status="working"]').first().waitFor({ state: "attached" });
      if (width === 390) await page.waitForFunction(() => Math.abs(document.querySelector(".sidebar.is-open")!.getBoundingClientRect().x) < 1);
      await page.screenshot({ path: join(evidence, `sidebar-working-${width}.png`) });
      await sidebar.locator(`[data-pane="${other.root_pane.pane_id}"]`).click();
      await rpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
      if (width === 390) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await sidebar.locator('[data-status="done"]').first().waitFor({ state: "attached" });
      if (width === 390) await page.waitForFunction(() => Math.abs(document.querySelector(".sidebar.is-open")!.getBoundingClientRect().x) < 1);
      await page.screenshot({ path: join(evidence, `sidebar-done-${width}.png`) });
      results[`browser_${width}`] = { chat: true, prompt_answer: true, waiting: true, working: true, done: true };
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await context.close();
      await rpc("pane.send_text", { pane_id: pane, text: "r" });
      await rpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "blocked" });
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    await context.request.post(`http://127.0.0.1:${fixture.app.port}/api/auth`, { data: { token: FLEET_TEST_TOKEN } });
    const page = await context.newPage();
    const sent: unknown[] = [];
    page.on("websocket", (ws) => ws.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload)) as { type: string };
      if (["input", "submit", "keys"].includes(frame.type)) { sent.push(frame); note({ surface: "browser", sent: frame }); }
    }));
    await rpc("pane.send_text", { pane_id: pane, text: "\r" });
    await rpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
    await page.addInitScript((key) => localStorage.setItem(`ovis:view:${key}`, "chat"), paneStorageId(machineId, pane));
    await page.goto(`http://127.0.0.1:${fixture.app.port}/?machine=${machineId}&pane=${encodeURIComponent(pane)}`);
    await page.getByRole("region", { name: "PC Fleet machine", exact: true }).locator(`[data-pane="${pane}"]`).click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.screenshot({ path: join(evidence, "before-crash.png") });
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Keep this draft across disconnects");
    const beforeInput = readFileSync(join(home, "input.jsonl"), "utf8");
    note({ surface: "process", invocation: ["kill", "-9", String(bridge.pid)] });
    bridge.kill("SIGKILL"); await bridge.exited;
    await publish();
    const row = page.getByRole("region", { name: "PC Fleet machine", exact: true });
    await row.locator(".machine-state-detail").filter({ hasText: "The Ovis server on this machine is not running." }).waitFor();
    await page.screenshot({ path: join(evidence, "bridge-down.png") });
    const oldToken = endpoint.token;
    bridge = start("fleet-bridge-restarted", [binary, "remote"], fleetEnv);
    await until(() => readAdvert().bridge_token !== oldToken, "replacement bridge advert");
    await publish();
    await row.locator(".machine-dot.is-connected").waitFor();
    await composer.waitFor();
    assert.equal(await composer.inputValue(), "Keep this draft across disconnects");
    assert.equal(readFileSync(join(home, "input.jsonl"), "utf8"), beforeInput);
    assert.equal(sent.length, 0);
    const beforeBoot = readAdvert().boot_id;
    note({ surface: "process", invocation: ["kill", "-9", String(engine.pid)] });
    engine.kill("SIGKILL"); await engine.exited;
    await until(() => readAdvert().runtime_down, "engine-down advert");
    await publish();
    await row.locator(".machine-state-detail").filter({ hasText: "The engine on this machine is not running or cannot be used." }).waitFor();
    await page.screenshot({ path: join(evidence, "engine-down.png") });
    const health = await curl("engine-down-health", endpoint.port, endpoint.token, "/api/health?scope=bridge");
    assert.equal(health.fleet_bridge.engine, "herdr");
    assert.equal(health.fleet_bridge.reason, "herdr_session_gone");
    engine = start("herdr-restarted", [baseEnv.OVIS_HERDR_BIN!, "--session", "fleet-qa", "server"], baseEnv);
    await until(() => !readAdvert().runtime_down && readAdvert().boot_id !== beforeBoot, "engine returned with new boot");
    await publish();
    await row.locator(".machine-dot.is-connected").waitFor();
    assert.equal(sent.length, 0);
    assert.equal(readAdvert().runtime_id, id);
    results.crash_recovery = { bridge: true, engine: true, draft_not_sent: true, changed_boot_id: true };
    await context.close();
  }
}

try { await Promise.race([run(), expired.promise]); }
finally {
  clearTimeout(phaseTimer);
  await browser?.close();
  for (const ws of connections) ws.close();
  machine?.stop();
  fixture.close();
  for (const proc of children.reverse()) { proc.kill(); await proc.exited; }
  writeFileSync(join(evidence, "results.json"), JSON.stringify(results, null, 2));
  rmSync(root, { recursive: true, force: true });
}
