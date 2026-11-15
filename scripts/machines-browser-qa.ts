/**
 * Run against SSH_TEST_KEEP=1's fixture. Delays real requests, never mocks APIs. Without a fixture path it runs the
 * fleet's part alone: a server started here with three fleet machines signed in on live machine sessions.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { herdrRpc } from "../server/herdr/client.ts";
import { paneStorageId } from "../shared/machines.ts";
import { FLEET_CAUSE_SENTENCE } from "../shared/fleet-cause.ts";
import { relayFixture } from "../server/relay/test-helpers.ts";
import { advertFrame, machineConnection, machineKey, pipeToTarget, testAdvert } from "../server/fleet/test-helpers.ts";
import { openSettingsPage } from "./settings-page.ts";
import { chromePath } from "./chrome-path.ts";

/**
 * The fleet's group in the sidebar: three machines, each answered by a stand-in bridge through its own local forward,
 * captured at 1280 and 390 px; then one machine's session drops, and its PC must show Offline with its cause within
 * one roster refresh, its roster drawn as not live (inert).
 */
async function fleetScenario(): Promise<void> {
  const server = relayFixture();
  const fleet = server.app.context.services.relay.fleet;
  // the fleet holds itself on a server with no token (todo 60): this one acts as if it had one before any store write
  fleet.setTokenConfigured(true);
  const names = ["Lab VM", "Build box", "GPU runner"];
  const tokens = new Map(names.map((name) => [randomBytes(32).toString("hex"), name] as const));
  const snapshot = (name: string) => ({
    version: "0.9.1", protocol: 22, agents: [], layouts: [], focused_pane_id: null,
    workspaces: [{ workspace_id: "w1", label: `${name} work`, number: 1, active_tab_id: "w1:t1", focused: false, agent_status: "unknown", pane_count: 1, tab_count: 1 }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1, focused: false, agent_status: "unknown", pane_count: 1 }],
    panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "t1", focused: false, agent_status: "unknown", cwd: "/", title: "shell" }],
  });
  const bridge = Bun.serve<{ name: string }>({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    fetch(request, bun) {
      const name = tokens.get(/^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "");
      if (name === undefined) return new Response(null, { status: 401 });
      const path = new URL(request.url).pathname;
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return bun.upgrade(request, { data: { name } }) ? undefined : new Response(null, { status: 400 });
      if (path === "/api/session") return Response.json({ snapshot: snapshot(name) });
      if (path === "/api/health") return Response.json({ herdr: { version: "0.9.1", protocol: 22 }, web_ui: { boot_id: `boot-${name}` } });
      return new Response(null, { status: 404 });
    },
    websocket: { message() {} },
  });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const evidence = join(process.cwd(), "evidence/machines"); mkdirSync(evidence, { recursive: true });
  try {
    const sessions = [];
    for (const [token, name] of tokens) {
      const key = await machineKey();
      fleet.store.add({ machine_id: key.id, public_key: key.spki, name });
      fleet.store.setState(key.id, "active");
      const connection = await machineConnection(server, fleet, { machineSessions: fleet }, { onPipe: (pipe) => pipeToTarget(pipe, bridge.port!) });
      await connection.hello();
      await connection.signIn(key);
      connection.mux.enqueueControl(advertFrame({ ...testAdvert(["bridge"]), runtime_id: `rt-${sessions.length}`, bridge_token: token }));
      sessions.push({ name, connection });
    }
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.app.port}/`);
    const group = page.getByRole("region", { name: "Fleet machines", exact: true });
    await group.locator(".machine-group:not(.is-offline)").nth(2).waitFor();
    assert.equal(await group.locator('.fleet-group-count [aria-hidden="true"]').innerText(), "3");
    assert.equal(await group.locator(".fleet-group-count .visually-hidden").textContent(), "3 fleet machines");
    assert.deepEqual(await group.locator(".machine-name").allInnerTexts(), ["Build box", "GPU runner", "Lab VM"]);
    await group.screenshot({ path: join(evidence, "fleet-group-1280.png") });
    console.log("PASS three fleet machines connected under one sidebar group with their count, sorted by name");

    // a machine whose link session drops: one roster refresh (5 s) at most, and its PC is offline with the cause
    const dropped = page.getByRole("region", { name: "PC Lab VM", exact: true });
    const started = performance.now();
    sessions[0]!.connection.stop();
    await dropped.locator(".machine-state-word").filter({ hasText: /^Offline$/ }).waitFor({ timeout: 5_000 });
    console.log(`offline shown after ${Math.round(performance.now() - started)} ms`);
    assert.match(await dropped.getAttribute("class") ?? "", /\bis-offline\b/);
    assert.equal(await dropped.locator(".machine-state-detail").innerText(), FLEET_CAUSE_SENTENCE.offline);
    // its terminals are not shown as live: its last roster is drawn inert, the others' stay live
    assert.equal(await dropped.locator(".machine-offline[inert]").count(), 1);
    assert.equal(await group.locator(".machine-offline[inert]").count(), 1);
    await group.screenshot({ path: join(evidence, "fleet-group-offline-1280.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
    await page.waitForFunction(() => Math.abs(document.querySelector(".sidebar.is-open")!.getBoundingClientRect().x) < 1);
    await group.scrollIntoViewIfNeeded();
    await group.screenshot({ path: join(evidence, "fleet-group-offline-390.png") });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.deepEqual(errors, []);
    console.log("PASS a dropped session shows Offline with its cause within one roster refresh, its roster not live; 1280 and 390 px captured");
  } finally {
    await browser.close();
    void bridge.stop(true);
    server.close();
  }
}

if (process.argv[2] === undefined) {
  await fleetScenario();
  process.exit(0);
}
const fixture = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { root: string; remoteHome: string; port: number; machineId: string; secondMachineId: string; paneId: string };
const { machineId: a, secondMachineId: b, paneId } = fixture;
const origin = `http://127.0.0.1:${fixture.port}`;
const evidence = join(process.cwd(), "evidence/machines"); mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage(); page.setDefaultTimeout(15_000);
const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
const inputs: { machine: string; pane: string }[] = [];
const pendingActions: { machine: string; pane: string; action: string }[] = [];
page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
  const message = JSON.parse(String(payload));
  const machine = new URL(socket.url()).searchParams.get("machine_id")!;
  if (message.type === "input" || message.type === "submit") inputs.push({ machine, pane: message.pane_id });
  if (message.type === "pending-action") pendingActions.push({ machine, pane: message.pane_id, action: message.action });
}));
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
async function select(name: string) {
  const group = page.getByRole("region", { name: `PC ${name}`, exact: true });
  await group.locator(`.pane-select[title^="${paneId} —"]`).click();
  await page.locator(".context .machine-context-name").filter({ hasText: name }).waitFor();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
}
/** Add PC from Add a connection's SSH tab (a phone opens the sheet on Phones and devices): an address typed, then Add */
async function addPcOverSsh() {
  const sheet = page.getByRole("dialog", { name: "Add a connection", exact: true });
  await sheet.locator('.connect-tabs [data-tab="ssh"]').click();
  await sheet.getByLabel("Or type an SSH address", { exact: true }).fill("qa@pc.invalid");
  await sheet.locator(".connect-ssh-form").getByRole("button", { name: "Add", exact: true }).click();
}
const composer = page.getByRole("textbox", { name: "Message", exact: true });
let releaseUpload = () => {};
const socket = join(fixture.remoteHome, ".config/herdr/sessions/ssh-qa/herdr.sock");
let pendingProgramRunning = false;
try {
  await page.goto(`${origin}/?machine=${a}&pane=${encodeURIComponent(paneId)}`);
  await page.locator(".conn-live").waitFor();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await composer.fill("PC A draft");
  await select("QA second PC");
  assert.equal(await composer.inputValue(), "");
  await composer.fill("PC B draft");
  await select("QA remote");
  assert.equal(await composer.inputValue(), "PC A draft");
  console.log("PASS same pane ID on two PCs retains separate drafts and header identity");

  const gate = new Promise<void>((resolve) => { releaseUpload = resolve; });
  const uploads: string[] = [];
  await page.route(`**/api/machines/${a}/pane/image`, async (route) => { uploads.push(route.request().url()); await gate; await route.continue(); });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=", "base64");
  await page.locator('input[type="file"]').setInputFiles([{ name: "first.png", mimeType: "image/png", buffer: png }, { name: "second.png", mimeType: "image/png", buffer: png }]);
  // attached files upload in parallel (#864), so both picked files are in flight at once
  for (let i = 0; i < 100 && uploads.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(uploads.length, 2);
  await select("QA second PC");
  const uploaded = page.waitForResponse((r) => r.url().endsWith(`${a}/pane/image`));
  releaseUpload(); assert.equal((await uploaded).status(), 200);
  assert.equal(await composer.inputValue(), "PC B draft");
  assert.equal(uploads.length, 2, "both late uploads went to PC A, none to PC B");
  console.log("PASS late image response and upload batch stay on their original PC");

  await composer.fill("printf 'browser_pc_b_ok\\n'");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  assert.deepEqual(inputs.at(-1), { machine: b, pane: paneId });
  await select("QA remote");
  // SSH_TEST_KEEP creates a loopback fixture with a private remoteHome. Give its
  // owned pane a foreground agent/byte recorder so queue acceptance is server-side.
  assert.match(fixture.root, /\/herdr-ssh-qa-[^/]+$/);
  assert.equal(fixture.remoteHome, join(fixture.root, "remote"));
  const program = join(fixture.remoteHome, "claude"); copyFileSync(process.execPath, program); chmodSync(program, 0o755);
  const log = join(fixture.remoteHome, "browser-pending.jsonl");
  const script = join(fixture.remoteHome, "browser-pending.cjs");
  writeFileSync(script, `const fs=require("node:fs");const log=process.argv[2];process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("\\x1b[?2004h\\n› Message\\n",()=>fs.writeFileSync(log,""));process.stdin.on("data",c=>{if(c.includes(3))process.exit(0);fs.appendFileSync(log,JSON.stringify(c.toString("utf8"))+"\\n");});`);
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `'${program}' '${script}' '${log}'\n` }, socket);
  pendingProgramRunning = true;
  await until(() => existsSync(log), "remote pending recorder");
  const bytes = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("");
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "working" }, socket);
  await page.locator('.composer-status[data-status="working"]').waitFor();
  await until(async () => await page.locator(".composer-agent-label").innerText() === "Claude", "remote foreground agent identity");
  const pendingRows = page.locator(".pending-message");
  for (const [index, text] of ["PENDING_A_SEND_NOW", "PENDING_A_MUST_NOT_REPLAY"].entries()) {
    await composer.fill(text);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await until(async () => await pendingRows.count() === index + 1 && await composer.inputValue() === "", "remote pending accepted");
    assert.deepEqual(inputs.at(-1), { machine: a, pane: paneId });
  }
  assert.equal(bytes(), "", "working Send retains text at the bridge");
  await pendingRows.first().getByRole("button", { name: /^Send now:/ }).click();
  await until(async () => await pendingRows.count() === 1 && bytes().endsWith("\r"), "remote explicit Send now");
  const delivered = "\u001b[200~PENDING_A_SEND_NOW\u001b[201~\r";
  assert.equal(bytes(), delivered);
  assert.deepEqual(pendingActions.at(-1), { machine: a, pane: paneId, action: "steer" });
  const count = inputs.length;
  await page.reload();
  await page.locator('.pending-message[data-state="uncertain"]').waitFor();
  assert.equal(await page.locator(".pending-message-bubble").innerText(), "PENDING_A_MUST_NOT_REPLAY");
  assert.equal(await page.locator(".pending-message-send").count(), 0, "unknown delivery cannot retry");
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" }, socket);
  await page.locator('.composer-status:not([data-status="working"])').waitFor();
  await page.waitForTimeout(400); // fixed wait: no saved input may be sent after the reload
  assert.equal(inputs.length, count, "reload and status changes never dispatch saved pending input");
  assert.equal(bytes(), delivered, "no automatic replay reaches the remote pty");
  await select("QA second PC");
  assert.equal(await pendingRows.count(), 0);
  await select("QA remote");
  assert.equal(await page.locator(".pending-message-bubble").innerText(), "PENDING_A_MUST_NOT_REPLAY");
  await page.getByRole("button", { name: "Discard saved copy", exact: true }).click();
  await pendingRows.waitFor({ state: "hidden" });
  // Older versions' held messages remain editable, manual and scoped to their PC.
  await page.evaluate(({ owner }) => localStorage.setItem(`ovis:queue:${owner}`, JSON.stringify({ version: 1, messages: [{ id: "legacy-machine-browser", text: "HELD_A_MUST_NOT_SEND" }] })), { owner: paneStorageId(a, paneId) });
  await page.reload(); await page.locator(".composer-queue-text").waitFor();
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "blocked" }, socket);
  await page.locator('.composer-status[data-status="blocked"]').waitFor();
  await page.waitForTimeout(400); // fixed wait: no held input may be sent while blocked
  assert.equal(bytes(), delivered, "legacy held input does not advance through blocked status");
  await select("QA second PC");
  assert.equal(await page.locator(".composer-queue-text").count(), 0);
  await select("QA remote");
  assert.equal(await page.locator(".composer-queue-text").inputValue(), "HELD_A_MUST_NOT_SEND");
  // with the prompt dock open the held rows are folded behind their caption (#466): open it first
  const heldToggle = page.locator(".composer-queue-toggle");
  if (await heldToggle.count() && await heldToggle.getAttribute("aria-expanded") !== "true") await heldToggle.click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await herdrRpc("pane.send_text", { pane_id: paneId, text: "\u0003" }, socket); pendingProgramRunning = false;
  console.log("PASS remote Send/Send now targets its PC once; saved pending and legacy held input never replay or cross PCs");

  await page.getByRole("button", { name: "New workspace on QA second PC", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New workspace · QA second PC", exact: true });
  await create.waitFor(); await create.getByRole("button", { name: "Close dialog", exact: true }).click();
  // Add PC lives in Settings → Devices and PCs → Add a connection → SSH: a typed address opens it filled in, and Settings closes
  await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
  await openSettingsPage(page, "Devices and PCs");
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Add a connection", exact: true }).click();
  await addPcOverSsh();
  const dialog = page.getByRole("dialog", { name: "Add PC", exact: true }); await dialog.waitFor();
  await page.screenshot({ path: join(evidence, "desktop-add-pc-dark.png") });
  await dialog.getByRole("button", { name: "Close PC setup" }).click();
  await page.screenshot({ path: join(evidence, "desktop-dark.png") });
  await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.screenshot({ path: join(evidence, "desktop-light.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await page.waitForFunction(() => Math.abs(document.querySelector(".sidebar.is-open")!.getBoundingClientRect().x) < 1);
  await page.screenshot({ path: join(evidence, "mobile-light.png") });
  await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
  await openSettingsPage(page, "Devices and PCs");
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Add a connection", exact: true }).click();
  await addPcOverSsh();
  await page.getByRole("dialog", { name: "Add PC", exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "mobile-add-pc-light.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.getByRole("button", { name: "Close PC setup" }).click();
  // Settings closed the drawer when it opened, and Add PC closed Settings: open the drawer again
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await page.locator(".sidebar-footer").getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await openSettingsPage(page, "Appearance");
  await settings.getByRole("button", { name: "Dark", exact: true }).click();
  await settings.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await page.waitForFunction(() => Math.abs(document.querySelector(".sidebar.is-open")!.getBoundingClientRect().x) < 1);
  await page.screenshot({ path: join(evidence, "mobile-dark.png") });
  assert.deepEqual(errors, []);
  console.log("PASS desktop/mobile, light/dark, PC creation target and setup modal; no browser errors");
} finally {
  releaseUpload();
  if (pendingProgramRunning) await herdrRpc("pane.send_text", { pane_id: paneId, text: "\u0003" }, socket).catch(() => {});
  await browser.close();
}
