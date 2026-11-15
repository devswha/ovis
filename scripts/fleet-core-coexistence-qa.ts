/** First-hour proof: two ordinary Ovis servers on one isolated core, before the fleet entry exists. */
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";
import { HcConnection } from "../server/herdr-core/connection.ts";
import { chromePath } from "./chrome-path.ts";
import { claudeProjectDir } from "../server/claude-store.ts";
import { loadRelayIdentity } from "../server/relay/identity.ts";
import { fleetTestServer, FLEET_TEST_TOKEN } from "../server/fleet/test-server.ts";
import { advertFrame, machineConnection, machineKey, pipeToTarget, testAdvert } from "../server/fleet/test-helpers.ts";
import { bounded } from "../server/relay/test-helpers.ts";
import { paneStorageId } from "../shared/machines.ts";
import { killCoreFixtureProcesses } from "../server/fleet/core-test-helpers.ts";

const evidence = process.env["UI_EVIDENCE_DIR"];
const bin = process.env["OVIS_TEST_HC_BIN"];
const binary = process.env["OVIS_QA_SERVER"];
if (!evidence || !bin) throw new Error("Set UI_EVIDENCE_DIR and OVIS_TEST_HC_BIN inside an isolated container");
mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "coex-hc-"));
for (const sub of ["home", "config", "state", "run", "one", "two"]) mkdirSync(join(root, sub), { mode: 0o700 });
const env: Record<string, string> = { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_RUNTIME_DIR: join(root, "run"), HC_SESSION: "fleet-coexistence", HC_SOCKET: join(root, "run/core.sock"), PATH: "/usr/local/bin:/usr/bin:/bin", SHELL: "/bin/bash", TMPDIR: tmpdir(), OVIS_HC_BIN: bin, OVIS_RUNTIME: "herdr-core", OVIS_ASSETS: process.cwd(), OVIS_TELEMETRY: "0", HOST: "127.0.0.1", PORT: "0" };
const note = (entry: unknown) => appendFileSync(join(evidence, "actions.jsonl"), JSON.stringify({ at: new Date().toISOString(), entry }) + "\n");
const children: ReturnType<typeof Bun.spawn>[] = [];
const corePids: number[] = [];
/** Every hc invocation uses this helper, with all isolating values present and outside the real home. */
function hcProcess(args: string[], pipe = false) {
  for (const name of ["HOME", "HC_SESSION", "HC_SOCKET", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]) if (!env[name] || (name !== "HC_SESSION" && !env[name]!.startsWith(root + "/"))) throw new Error(`Refusing unisolated hc: ${name}`);
  note({ surface: "CLI", invocation: ["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), bin, ...args] });
  const child = Bun.spawn([bin!, ...args], { env, stdin: pipe ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
  children.push(child);
  return child;
}
async function hcRun(args: string[]) {
  const child = hcProcess(args);
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  note({ args, out, err, code });
  assert.equal(code, 0, err);
  return out;
}
function bound<T>(promise: Promise<T>, label: string, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms); })]).finally(() => clearTimeout(timer));
}
const hc = new HcConnection(() => {
  const child = hcProcess(["connect"], true);
  return { readable: child.stdout, write: (bytes: Uint8Array) => { if (child.stdin !== null && typeof child.stdin !== "number") { child.stdin.write(bytes); void child.stdin.flush(); } }, exited: child.exited, kill: () => child.kill() };
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const sockets: WebSocket[] = [];
const results: Record<string, unknown> = {};
interface Endpoint { port: number; token: string; machineId?: string }
interface Advert { bridge_port: number; bridge_token: string; runtime_id: string; boot_id: string; runtime_down: boolean; versions: { server: string; agent: string; runtime: string } }
const fleetState = join(root, "fleet/state");
mkdirSync(fleetState, { recursive: true });
const advertPath = join(fleetState, "advert.json");
const readAdvert = () => JSON.parse(readFileSync(advertPath, "utf8")) as Advert;
function fileReady(path: string, check: () => boolean, label: string) {
  const ready = Promise.withResolvers<void>();
  const changed = () => { if (check()) ready.resolve(); };
  const watcher = watch(dirname(path), changed); changed();
  return bound(ready.promise, label).finally(() => watcher.close());
}
let controller: ReturnType<typeof fleetTestServer> | undefined;
let link: Awaited<ReturnType<typeof machineConnection>> | undefined;
let bridgeProcess: ReturnType<typeof Bun.spawn> | undefined;
let ownProcess: ReturnType<typeof Bun.spawn> | undefined;
const target = { port: 0, token: "" };
let publish: (() => Promise<void>) | undefined;
const fleetEnv = { ...env, OVIS_FLEET_BRIDGE: "1", OVIS_FLEET_HOME: join(root, "fleet"), OVIS_FLEET_STATE: fleetState, OVIS_STATE_DIR: join(root, "one") };
async function launchBridge() {
  const previous = existsSync(advertPath) ? readFileSync(advertPath, "utf8") : null;
  const ready = fileReady(advertPath, () => existsSync(advertPath) && readFileSync(advertPath, "utf8") !== previous, "new fleet advert");
  const args = [binary!, "remote"];
  note({ surface: "CLI", invocation: ["env", "-i", ...Object.entries(fleetEnv).map(([k, v]) => `${k}=${v}`), ...args] });
  bridgeProcess = Bun.spawn(args, { env: fleetEnv, stdin: "ignore", stdout: Bun.file(join(evidence!, "fleet-bridge.log")), stderr: Bun.file(join(evidence!, "fleet-bridge.log")) }); children.push(bridgeProcess);
  await Promise.race([ready, bridgeProcess.exited.then((code) => { throw new Error(`bridge exited ${code}`); })]);
  return bridgeProcess;
}
async function start(name: string): Promise<Endpoint & { child: ReturnType<typeof Bun.spawn> }> {
  if (name === "two" && binary) {
    const child = await launchBridge();
    const disk = readAdvert(); target.port = disk.bridge_port; target.token = disk.bridge_token;
    assert.equal(disk.runtime_id, loadRelayIdentity(join(root, "one")).server_id);
    assert.equal((await curl(target, "fleet-health", "/api/health")).herdr.terminal_attach, true);
    const health = await curl(target, "fleet-scoped-health", "/api/health?scope=bridge");
    assert.equal(health.fleet_bridge.terminal_mode, "attach"); assert.equal(health.fleet_bridge.engine, "herdr-core");
    const controllerHome = join(root, "controller-home"); mkdirSync(controllerHome);
    const controllerConfig = join(root, "controller-config");
    const controllerSocket = join(controllerConfig, "herdr/sessions/fleet-controller/herdr.sock");
    mkdirSync(dirname(controllerSocket), { recursive: true });
    const controllerReady = fileReady(controllerSocket, () => existsSync(controllerSocket), "controller engine socket");
    const controllerEnv = { ...env, HOME: controllerHome, XDG_CONFIG_HOME: controllerConfig, HERDR_SOCKET: controllerSocket, OVIS_RUNTIME: "herdr" };
    const controllerCommand = [Bun.which("herdr")!, "--session", "fleet-controller", "server"];
    note({ surface: "CLI", invocation: ["env", "-i", ...Object.entries(controllerEnv).map(([k, v]) => `${k}=${v}`), ...controllerCommand] });
    const engine = Bun.spawn(controllerCommand, { env: controllerEnv, stdin: "ignore", stdout: Bun.file(join(evidence!, "controller-engine.log")), stderr: Bun.file(join(evidence!, "controller-engine.log")) }); children.push(engine);
    await controllerReady;
    process.env["HERDR_SOCKET"] = controllerSocket;
    controller = fleetTestServer({ stateDir: join(root, "controller"), machines: true });
    const fleet = controller.app.context.services.relay.fleet; fleet.start();
    const key = await machineKey(); fleet.store.add({ machine_id: key.id, public_key: key.spki, name: "Core fleet machine" }); fleet.store.setState(key.id, "active");
    link = await machineConnection(controller, fleet, { machineSessions: fleet }, { onPipe: (pipe) => pipeToTarget(pipe, target.port) });
    await link.hello(); await link.signIn(key);
    publish = async () => {
      const advert = readAdvert(); target.port = advert.bridge_port; target.token = advert.bridge_token;
      let up = false;
      try { up = (await fetch(`http://127.0.0.1:${target.port}/api/health?scope=bridge`, { headers: { authorization: `Bearer ${target.token}` } })).ok; } catch { /* real stopped bridge */ }
      link!.mux.enqueueControl(advertFrame({ ...testAdvert(["bridge"]), runtime_id: advert.runtime_id, boot_id: advert.boot_id, bridge_token: advert.bridge_token, versions: { ...advert.versions, link: "test" }, health: { bridge: up ? "up" : "down", runtime: advert.runtime_down ? "down" : "up" } }));
      await bounded(link!.mux.measure());
    };
    const connected = Promise.withResolvers<void>();
    const unwatch = controller.app.context.services.core.machines!.subscribe((event) => {
      if (event.type === "machines" && event.machines.some((row) => row.id === `fleet-${key.id}` && row.state === "connected")) connected.resolve();
    });
    try { await publish(); await bound(connected.promise, "controller fleet row connected"); } finally { unwatch(); }
    return { child, port: controller.app.port, token: FLEET_TEST_TOKEN, machineId: `fleet-${key.id}` };
  }
  const ready = Promise.withResolvers<{ port: number; token: string }>();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fleet-core-ordinary-fixture.ts")], { env: { ...env, OVIS_STATE_DIR: join(root, name) }, stdin: "ignore", stdout: Bun.file(join(evidence, `${name}.log`)), stderr: Bun.file(join(evidence, `${name}.log`)), ipc: (value) => ready.resolve(value as { port: number; token: string }) });
  note({ surface: "Ovis server", invocation: [process.execPath, "scripts/fleet-core-ordinary-fixture.ts"], env: { ...env, OVIS_STATE_DIR: join(root, name) }, pid: child.pid });
  children.push(child);
  if (name === "one") ownProcess = child;
  return { child, ...await bound(Promise.race([ready.promise, child.exited.then((code) => { throw new Error(`${name} exited ${code}`); })]), `${name} ready`) };
}
function viewer(endpoint: Endpoint, name: string) {
  const url = `ws://127.0.0.1:${endpoint.port}/ws${endpoint.machineId ? `?machine_id=${endpoint.machineId}` : ""}`;
  note({ surface: "page WebSocket", name, invocation: url });
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${endpoint.token}` } });
  sockets.push(ws);
  const frames: Record<string, unknown>[] = [];
  let screen = "";
  const waiters = new Set<() => void>();
  ws.addEventListener("message", (event) => { const frame = JSON.parse(String(event.data)); frames.push(frame); if (frame.type === "pty-data") screen += frame.data; note({ name, received: frame }); for (const wake of waiters) wake(); });
  const wait = (check: () => boolean, label: string) => {
    const done = Promise.withResolvers<void>();
    const wake = () => { if (check()) done.resolve(); };
    waiters.add(wake); wake();
    return bound(done.promise, label).finally(() => waiters.delete(wake));
  };
  return { ws, frames, screen: () => screen, open: bound(new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("socket open failed")); }), name), wait, send: (frame: unknown) => { note({ name, sent: frame }); ws.send(JSON.stringify(frame)); } };
}
async function curl(endpoint: Endpoint, label: string, path: string, body?: unknown) {
  if (endpoint.machineId) path = `/api/machines/${endpoint.machineId}${path.slice(4)}`;
  const command = ["curl", "-i", "-sS", "--max-time", "15", "-H", `Authorization: Bearer ${endpoint.token}`, ...(body === undefined ? [] : ["-H", "Content-Type: application/json", ...(endpoint.machineId ? ["-H", "x-herdr-machine: 1"] : []), "--data", JSON.stringify(body)]), `http://127.0.0.1:${endpoint.port}${path}`];
  note({ surface: "HTTP", invocation: command });
  const p = Bun.spawn(command, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const text = await new Response(p.stdout).text();
  assert.equal(await p.exited, 0);
  writeFileSync(join(evidence, `${label}.http.txt`), text);
  assert.match(text, /^HTTP\/1.1 200/);
  return JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4));
}
try {
  results.version = (await hcRun(["--version"])).trim();
  await hcRun(["server", "start"]);
  const status = JSON.parse(await hcRun(["server", "status", "--json"]));
  corePids.push(status.pid, ...(status.holder ? [status.holder.pid] : []));
  const home = env.HOME!;
  const session = "8d8f7d39-6788-49f3-b071-e3ba985c163c";
  const project = join(home, ".claude/projects", claudeProjectDir(home));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, session + ".jsonl"), [{ type: "user", message: { content: "Verify two core viewers." } }, { type: "assistant", message: { content: [{ type: "text", text: "Both core viewers share this terminal." }] } }].map((x) => JSON.stringify(x)).join("\n") + "\n");
  copyFileSync(Bun.which("node")!, join(home, "claude"));
  const script = join(home, "claude.cjs");
  copyFileSync(join(import.meta.dir, "fixtures/fleet-core-agent.cjs"), script);
  const record = await hc.call("terminal.run", { argv: [join(home, "claude"), script, home, session], cwd: home });
  const pane = record.address;
  loadRelayIdentity(join(root, "one"));
  const one = await start("one");
  const two = await start("two");
  for (const [first, second, direction] of [[one, two, "one-then-two"], [two, one, "two-then-one"]] as const) {
    const a = viewer(first, direction + "-first"); await a.open;
    a.send({ type: "attach", pane_id: pane, cols: 100, rows: 30 });
    await a.wait(() => a.screen().includes("HIST-300"), "first live paint");
    const b = viewer(second, direction + "-second"); await b.open;
    b.send({ type: "attach", pane_id: pane, cols: 70, rows: 20 });
    await b.wait(() => b.screen().includes("HIST-300"), "second simultaneous paint");
    assert.equal(b.frames.some((f) => f.code === "attach_held"), false);
    const opened = await hc.call("terminal.get", { terminal: pane });
    assert.deepEqual([opened.cols, opened.rows], [70, 20]);
    const firstText = `FIRST-${direction}`;
    a.send({ type: "input", pane_id: pane, text: firstText });
    await Promise.all([a.wait(() => a.screen().includes(`RECEIVED:${firstText}`), "first input on first viewer"), b.wait(() => b.screen().includes(`RECEIVED:${firstText}`), "first input on second viewer")]);
    const typed = await hc.call("terminal.get", { terminal: pane });
    assert.deepEqual([typed.cols, typed.rows], [100, 30]);
    const secondText = `SECOND-${direction}`;
    b.send({ type: "input", pane_id: pane, text: secondText });
    await Promise.all([a.wait(() => a.screen().includes(`RECEIVED:${secondText}`), "second input on first viewer"), b.wait(() => b.screen().includes(`RECEIVED:${secondText}`), "second input on second viewer")]);
    b.send({ type: "resize", pane_id: pane, cols: 81, rows: 25 });
    // The ordered line's terminal.get follows the viewer's output event, so observe the size event itself.
    const sized = Promise.withResolvers<void>();
    const subscription = await hc.events({ terminal: pane }, { onData: (bytes) => { if (new TextDecoder().decode(bytes).includes('"cols":82')) sized.resolve(); }, onClose: () => {} });
    b.send({ type: "resize", pane_id: pane, cols: 82, rows: 26 });
    await bound(sized.promise, "resize event"); await subscription.channel.close();
    const resized = await hc.call("terminal.get", { terminal: pane });
    assert.deepEqual([resized.cols, resized.rows], [82, 26]);
    for (const [ep, name] of [[first, "first"], [second, "second"]] as const) assert.ok((await curl(ep, direction + "-" + name, "/api/session")).snapshot.panes.some((p: { pane_id: string }) => p.pane_id === pane));
    results[direction] = { both_live: true, both_type: true, held: false, opening_size: [opened.cols, opened.rows], first_input_size: [typed.cols, typed.rows], resized: [resized.cols, resized.rows] };
    a.ws.close(); b.ws.close();
    await hc.call("terminal.keys", { terminal: pane, keys: ["Enter"] });
  }
  if (process.env["OVIS_QA_HTTP_ONLY"] === "1") {
    const live = viewer(two, "fleet-chat-card-status"); await live.open;
    live.send({ type: "attach", pane_id: pane, cols: 100, rows: 30 });
    await live.wait(() => live.screen().includes("HIST-300"), "fleet agent stream");
    const conversation = await curl(two, "conversation", `/api/pane/conversation?pane_id=${pane}`);
    assert.equal(conversation.source, "claude-transcript"); assert.ok(JSON.stringify(conversation).includes("Both core viewers share this terminal."));
    const ordinaryConversation = await curl(one, "ordinary-conversation", `/api/pane/conversation?pane_id=${pane}`);
    assert.equal(ordinaryConversation.source, conversation.source); assert.ok(JSON.stringify(ordinaryConversation).includes("Both core viewers share this terminal."));
    await hc.call("terminal.keys", { terminal: pane, keys: ["r"] });
    await live.wait(() => live.screen().includes("Yes, I trust this folder"), "screen-read menu");
    const prompt = await curl(two, "prompt", `/api/pane/prompt?pane_id=${pane}`);
    assert.ok(prompt.prompt.options.some((option: { label: string }) => option.label === "Yes, I trust this folder"));
    const ordinaryPrompt = await curl(one, "ordinary-prompt", `/api/pane/prompt?pane_id=${pane}`);
    assert.deepEqual(ordinaryPrompt.prompt.options, prompt.prompt.options);
    const answered = fileReady(join(home, "answers"), () => readFileSync(join(home, "answers"), "utf8").includes("Yes, I trust this folder"), "HTTP card answered");
    await curl(two, "prompt-answer", "/api/pane/prompt/answer", { pane_id: pane, prompt_id: prompt.prompt.id, option_index: 1 }); await answered;
    await hc.call("terminal.keys", { terminal: pane, keys: ["w"] });
    await live.wait(() => live.frames.some((frame) => frame.type === "pane-status" && frame.agent_status === "working"), "OSC status forwarded");
    results.http = { transcript: true, card_answer: true, osc_status: true }; live.ws.close();
  } else {
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const contexts = await Promise.all([one, two].map(async (ep) => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    await context.request.post(`http://127.0.0.1:${ep.port}/api/auth`, { data: { token: ep.token } });
    await context.addInitScript((key) => localStorage.setItem(`ovis:view:${key}`, "terminal"), paneStorageId(ep.machineId ?? "local", pane));
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("websocket", (ws) => ws.on("framesent", ({ payload }) => note({ surface: "browser", port: ep.port, sent: String(payload) })));
    note({ surface: "browser", invocation: `goto http://127.0.0.1:${ep.port}/?${ep.machineId ? `machine=${ep.machineId}&` : ""}pane=${pane}` });
    await page.goto(`http://127.0.0.1:${ep.port}/?${ep.machineId ? `machine=${ep.machineId}&` : ""}pane=${pane}`);
    if (ep.machineId) { note({ surface: "browser", invocation: "dismiss fresh-controller setup with I have used Ovis before" }); await page.getByRole("button", { name: /I.ve used Ovis before/ }).click(); }
    await page.screenshot({ path: join(evidence, `initial-${ep.port}.png`) });
    writeFileSync(join(evidence, `initial-${ep.port}.html`), await page.content());
    try { await page.getByRole("button", { name: "Terminal", exact: true }).click(); }
    catch (error) { await page.screenshot({ path: join(evidence, `failed-${ep.port}.png`) }); writeFileSync(join(evidence, `failed-${ep.port}.html`), await page.content()); throw error; }
    await page.locator(".pane-terminal").first().waitFor();
    return { context, page };
  }));
  const [a, b] = contexts as [typeof contexts[number], typeof contexts[number]];
  const rows = (page: typeof a.page) => page.locator(".pane-terminal").first().innerText();
  await a!.page.waitForFunction(() => document.querySelector(".pane-terminal")?.textContent?.includes("RECEIVED"));
  await b!.page.waitForFunction(() => document.querySelector(".pane-terminal")?.textContent?.includes("RECEIVED"));
  const otherBefore = await rows(b!.page);
  const scrolledBefore = await rows(a!.page);
  const box = await a!.page.locator(".pane-terminal").first().boundingBox(); assert.ok(box);
  note({ surface: "browser", invocation: "first viewer: wheel -700 inside terminal; second viewer: compare drawn rows" });
  await a!.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await a!.page.mouse.wheel(0, -700);
  await a!.page.waitForFunction((before) => (document.querySelector(".pane-terminal") as HTMLElement | null)?.innerText !== before, scrolledBefore);
  assert.equal(await rows(b!.page), otherBefore);
  await a!.page.screenshot({ path: join(evidence, "first-scrolled.png") });
  await b!.page.screenshot({ path: join(evidence, "second-unscrolled.png") });
  await a!.page.getByRole("button", { name: "Chat", exact: true }).click();
  await a!.page.getByRole("log").getByText("Both core viewers share this terminal.", { exact: true }).waitFor();
  const composer = a!.page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("UNSENT-CORE-DRAFT");
  const beforeInput = readFileSync(join(home, "inputs"), "utf8");
  await b!.page.getByRole("button", { name: "Chat", exact: true }).click();
  await b!.page.getByRole("log").getByText("Both core viewers share this terminal.", { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), "UNSENT-CORE-DRAFT");
  assert.equal(readFileSync(join(home, "inputs"), "utf8"), beforeInput);
  await a!.page.screenshot({ path: join(evidence, "first-unsent-draft.png") });
  await b!.page.screenshot({ path: join(evidence, "second-chat.png") });
  results.browser = { local_scroll_only: true, draft_stays_unsent: true, shared_chat_read: true };
  assert.equal(one.child.exitCode, null); assert.equal(two.child.exitCode, null);
  for (const item of contexts) await item.context.close();
  if (binary) {
    const other = await hc.call("terminal.run", { argv: ["bash", "-c", "read -r line"], cwd: home });
    for (const width of [1440, 390]) {
      await hc.call("terminal.keys", { terminal: pane, keys: ["r"] });
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US" });
      await context.request.post(`http://127.0.0.1:${two.port}/api/auth`, { data: { token: two.token } });
      await context.addInitScript((key) => localStorage.setItem(`ovis:view:${key}`, "chat"), paneStorageId(two.machineId!, pane));
      const page = await context.newPage(); page.setDefaultTimeout(20_000);
      page.on("pageerror", (error) => note({ surface: "browser", width, error: error.message }));
      note({ surface: "browser", width, invocation: `goto http://127.0.0.1:${two.port}/?machine=${two.machineId}&pane=${pane}; open Chat; answer card; inspect reported statuses` });
      await page.goto(`http://127.0.0.1:${two.port}/?machine=${two.machineId}&pane=${pane}`);
      await page.getByRole("button", { name: /I.ve used Ovis before/ }).click();
      await page.getByRole("log").getByText("Both core viewers share this terminal.", { exact: true }).waitFor();
      await page.getByRole("button", { name: /Yes, I trust this folder/ }).waitFor();
      await page.screenshot({ path: join(evidence, `fleet-chat-card-${width}.png`) });
      const row = page.getByRole("region", { name: "PC Core fleet machine", exact: true });
      if (width === 390) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await row.locator('[data-status="blocked"]').first().waitFor({ state: "attached" });
      if (width === 390) await page.waitForFunction(() => Math.abs(document.querySelector(".sidebar.is-open")!.getBoundingClientRect().x) < 1);
      await page.screenshot({ path: join(evidence, `fleet-waiting-${width}.png`) });
      if (width === 390) await page.keyboard.press("Escape");
      const beforeAnswers = readFileSync(join(home, "answers"), "utf8");
      const answered = fileReady(join(home, "answers"), () => readFileSync(join(home, "answers"), "utf8") !== beforeAnswers, "screen-read card answer reached agent");
      const response = page.waitForResponse((r) => r.url().endsWith("/pane/prompt/answer"));
      note({ surface: "browser", width, invocation: "click the Yes, I trust this folder prompt-card button" });
      await page.getByRole("button", { name: /Yes, I trust this folder/ }).click();
      assert.equal((await response).status(), 200); await answered;
      assert.ok(readFileSync(join(home, "answers"), "utf8").endsWith("Yes, I trust this folder\n"));
      await page.getByRole("button", { name: /Yes, I trust this folder/ }).waitFor({ state: "detached" });
      await page.screenshot({ path: join(evidence, `fleet-answered-${width}.png`) });
      await hc.call("terminal.keys", { terminal: pane, keys: ["w"] });
      if (width === 390) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await row.locator('[data-status="working"]').first().waitFor({ state: "attached" });
      if (width === 390) await page.waitForFunction(() => Math.abs(document.querySelector(".sidebar.is-open")!.getBoundingClientRect().x) < 1);
      await page.screenshot({ path: join(evidence, `fleet-working-${width}.png`) });
      if (width === 390) await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: other.address, exact: true }).click();
      await hc.call("terminal.keys", { terminal: pane, keys: ["d"] });
      if (width === 390) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await row.locator('[data-status="done"]').first().waitFor({ state: "attached" });
      if (width === 390) await page.waitForFunction(() => Math.abs(document.querySelector(".sidebar.is-open")!.getBoundingClientRect().x) < 1);
      await page.screenshot({ path: join(evidence, `fleet-done-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      results[`browser_${width}`] = { chat: true, card_answer: true, waiting: true, working: true, done: true };
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    await context.request.post(`http://127.0.0.1:${two.port}/api/auth`, { data: { token: two.token } });
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    const sent: unknown[] = [];
    const recoveryPaint = Promise.withResolvers<void>();
    let recoveryOutput = "";
    page.on("websocket", (ws) => ws.on("framereceived", ({ payload }) => {
      if (!ws.url().includes(`machine_id=${two.machineId}`)) return;
      const frame = JSON.parse(String(payload)); note({ surface: "browser recovery", received: frame });
      if (frame.type === "pty-data") { recoveryOutput += frame.data; if (recoveryOutput.includes("CORE-RECOVERY-LIVE")) recoveryPaint.resolve(); }
    }));
    page.on("websocket", (ws) => ws.on("framesent", ({ payload }) => { const frame = JSON.parse(String(payload)); if (["input", "keys", "submit"].includes(frame.type) && frame.automatic !== true) { sent.push(frame); note({ surface: "browser", sent: frame }); } }));
    await page.goto(`http://127.0.0.1:${two.port}/?machine=${two.machineId}&pane=${pane}`);
      await page.getByRole("button", { name: /I.ve used Ovis before/ }).click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("log").getByText("Both core viewers share this terminal.", { exact: true }).waitFor();
    const draft = page.getByRole("textbox", { name: "Message", exact: true }); await draft.fill("Keep this core draft unsent");
    const beforeInput = readFileSync(join(home, "inputs"), "utf8");
    note({ surface: "OS process", invocation: ["kill", "-9", String(bridgeProcess!.pid)] });
    bridgeProcess!.kill("SIGKILL"); await bridgeProcess!.exited; await publish!();
    const row = page.getByRole("region", { name: "PC Core fleet machine", exact: true });
    await row.locator(".machine-state-detail").filter({ hasText: "The Ovis server on this machine is not running." }).waitFor();
    await page.screenshot({ path: join(evidence, "fleet-bridge-down.png") });
    const boot = readAdvert().boot_id;
    await launchBridge(); await publish!();
    await row.locator(".machine-dot.is-connected").waitFor();
    assert.equal(await draft.inputValue(), "Keep this core draft unsent");
    assert.equal(readFileSync(join(home, "inputs"), "utf8"), beforeInput);
    assert.equal(readAdvert().boot_id, boot);
    // Ordinary Ovis intentionally auto-starts hc. Stop that fixture so this experiment attributes
    // all recovery attempts to the fleet bridge, whose no-start rule is under test.
    note({ surface: "OS process", invocation: ["kill", "-TERM", String(ownProcess!.pid)], purpose: "exclude ordinary Ovis auto-start from fleet failure proof" });
    ownProcess!.kill(); await ownProcess!.exited;
    const ended = Promise.withResolvers<void>();
    await hc.events({}, { onData: () => {}, onClose: () => ended.resolve() });
    const down = fileReady(advertPath, () => readAdvert().runtime_down, "core-down advert");
    note({ surface: "OS process", invocation: ["kill", "-9", String(status.pid)] });
    process.kill(status.pid, "SIGKILL"); await bound(ended.promise, "core line ended"); hc.close();
    await down; await publish!();
    await row.locator(".machine-state-detail").filter({ hasText: "The engine on this machine is not running or cannot be used." }).waitFor();
    await page.screenshot({ path: join(evidence, "fleet-core-down.png") });
    const health = await curl(target, "core-down-health", "/api/health?scope=bridge");
    assert.equal(health.fleet_bridge.reason, "hc_session_gone");
    const back = fileReady(advertPath, () => !readAdvert().runtime_down && readAdvert().boot_id !== boot, "new core lifetime");
    await hcRun(["server", "start"]);
    const restarted = JSON.parse(await hcRun(["server", "status", "--json"])); corePids.push(restarted.pid, ...(restarted.holder ? [restarted.holder.pid] : []));
    await back; await publish!();
    await row.locator(".machine-dot.is-connected").waitFor();
    // The roster can recover before the page's terminal socket. Prove that socket has resumed too.
    await page.getByText("Connected", { exact: true }).last().waitFor();
    assert.equal(sent.length, 0);
    // A new engine lifetime may reuse pane IDs. Its old draft belongs in the product's recovery
    // dialog until the user deliberately puts it into a message box; a bridge-only restart kept it in place.
    note({ surface: "browser", invocation: "right-click the returned terminal; Recover unsent text; inspect old draft; Put in message box" });
    await page.locator(".pane-frame.is-current").click({ button: "right", position: { x: 30, y: 30 } });
    await page.getByRole("menuitem", { name: "Recover unsent text", exact: true }).click();
    await page.getByRole("dialog").getByText("Keep this core draft unsent", { exact: true }).waitFor();
    await page.screenshot({ path: join(evidence, "fleet-core-draft-recovery.png") });
    await page.getByRole("button", { name: "Put in message box", exact: true }).click();
    note({ surface: "Core RPC", invocation: { method: "terminal.keys", params: { terminal: pane, keys: ["l"] } }, purpose: "fixture emits a fresh marker to prove the recovered page socket" });
    await hc.call("terminal.keys", { terminal: pane, keys: ["l"] });
    await bound(recoveryPaint.promise, "fresh output on recovered page socket");
    await page.getByText("Connected", { exact: true }).last().waitFor();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await draft.inputValue(), "Keep this core draft unsent"); assert.equal(sent.length, 0);
    results.recovery = { bridge_restart_preserves_boot: true, core_restart_changes_boot: true, bridge_draft_stays_in_composer: true, core_draft_recovered_by_user: true, fresh_output_after_core_restart: true, no_automatic_input: true };
    await page.screenshot({ path: join(evidence, "fleet-reconnected-draft.png") });
    await context.close();
  }
  }
  console.log("COEXISTENCE", JSON.stringify(results));
} catch (error) {
  let index = 0;
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    if (!page.isClosed()) await page.screenshot({ path: join(evidence, `failure-${index++}.png`) });
  }
  throw error;
} finally {
  await browser?.close();
  for (const ws of sockets) ws.close();
  link?.stop(); controller?.close();
  hc.close();
  for (const child of children.reverse()) { child.kill(); await child.exited; }
  for (const pid of corePids) { try { process.kill(pid, "SIGKILL"); } catch { /* exact fixture process already gone */ } }
  writeFileSync(join(evidence, "coexistence.json"), JSON.stringify(results, null, 2));
  const remainingFixturePids = killCoreFixtureProcesses(root);
  note({ cleanup: "SIGKILL exact isolated core, per-terminal holder and program PIDs; container init reaps", corePids, remainingFixturePids });
  rmSync(root, { recursive: true, force: true });
}
