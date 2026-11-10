import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { Machine, RelayPairingRequest } from "../shared/machines.ts";
import { chromePath } from "./chrome-path.ts";

// A built client with an in-memory API; no relay, no herdr and no user session. The PC's prompt for a
// device waiting for approval (src/components/RelayPairingPrompt.tsx), told over the event stream as
// server/dispatch.ts does (`relay-pairings`), in a real browser for what the unit test's hand-made
// nodes cannot show: where the focus really goes, what Tab and Escape do, and which of the page's
// "a dialog is open" checks the prompt trips.
const snapshot = { version: "0.9.3", protocol: 22, focused_workspace_id: null, focused_tab_id: null, focused_pane_id: null, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] };
const local = { id: "local", name: "QA host", kind: "local", state: "connected", enabled: true, error: null, snapshot } as Machine;
let waiting: RelayPairingRequest[] = [];
const decided: { id: string; decision: string }[] = [];
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
const send = (stream: ReadableStreamDefaultController<Uint8Array>, event: unknown) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
const tell = () => { for (const stream of streams) send(stream, { type: "relay-pairings", pairings: waiting }); };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/health") return Response.json({ ok: true, auth: { authenticated: true, required: false, role: "drive" }, herdr: { version: "0.9.3", protocol: 22 }, web_ui: { revision: null, boot_id: "qa" } });
  if (path === "/api/machines") return Response.json({ machines: [local] });
  if (path === "/api/machines/events") {
    let held: ReadableStreamDefaultController<Uint8Array> | undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { held = controller; streams.add(controller); controller.enqueue(new TextEncoder().encode(": open\n\n")); send(controller, { type: "relay-pairings", pairings: waiting }); },
      cancel() { if (held) streams.delete(held); },
    }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  }
  if (path === "/api/session") return Response.json({ snapshot });
  if (path === "/api/machines/settings") return Response.json({ auto_update_bridges: false });
  if (path === "/api/relay/pairing" && request.method === "POST") {
    const body = await request.json() as { id: string; decision: string };
    decided.push(body);
    waiting = waiting.filter(({ id }) => id !== body.id);
    tell();
    return new Response(null, { status: 204 });
  }
  if (path.startsWith("/api/") || path === "/ws") return Response.json({ error: { code: "qa", message: "Unavailable in fixture" } }, { status: 404 });
  const file = Bun.file(resolve("dist", path === "/" ? "index.html" : path.slice(1)));
  return new Response(await file.exists() ? file : Bun.file("dist/index.html"));
} });

let asked = 0;
/** A device asks: the PC's clock is two minutes behind this browser's, so only `left_ms` gives the right seconds. */
function ask(over: Partial<RelayPairingRequest> = {}): RelayPairingRequest {
  const request: RelayPairingRequest = { id: `p${++asked}`, label: "Hako's iPhone", digits: "725403", expires_at: new Date(Date.now() - 30_000).toISOString(), left_ms: 90_000, ...over };
  waiting = [...waiting, request];
  tell();
  return request;
}
function withdraw(): void { waiting = []; tell(); }

/** what has the focus: the prompt's surface, one of its buttons, Settings (a field of its own told apart), a field of the page, or something else */
const focus = (page: Page): Promise<string> => page.evaluate(() => {
  const active = document.activeElement;
  if (active === null || active === document.body) return "nothing";
  if (active.matches(".relay-pairing-prompt")) return "prompt";
  if (active.closest(".relay-pairing-prompt") !== null) return `prompt ${active.textContent}`;
  if (active.closest(".settings-dialog") !== null) return active.matches("textarea, input, select") ? "settings field" : "settings";
  if (active.matches("textarea, input")) return "field";
  return "elsewhere";
});

const browser = await chromium.launch({ headless: true, executablePath: chromePath(), args: ["--no-sandbox"] }).catch((error: unknown) => { server.stop(true); throw error; });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  await page.goto(server.url.href);
  await page.locator(".app-header").first().waitFor({ timeout: 10_000 });
  const prompt = page.locator('[data-testid="relay-pairing-prompt"]');
  const sentence = prompt.locator(":scope > span > span").first();
  const settings = page.locator(".settings-dialog");
  /** a fetch of the page's that the server answers after any decision the page sent before it */
  const settled = () => page.evaluate(() => fetch("/api/health").then(() => undefined));

  // 1. Settings open, the focus on one of its buttons: the prompt takes it on its own surface. A key that
  //    presses Approve the moment the prompt is there (typed for what was under it) approves nothing:
  //    a click no pointer made is what Enter or Space on the button gives
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await settings.waitFor();
  await page.waitForFunction(() => document.querySelector(".settings-dialog")?.getAnimations().length === 0);
  await settings.locator("button:visible").first().focus();
  assert.equal(await focus(page), "settings");
  await page.evaluate(() => {
    const watch = new MutationObserver(() => {
      const approve = document.querySelector<HTMLElement>(".relay-pairing-prompt .btn-primary");
      if (approve === null) return;
      watch.disconnect();
      approve.click();
      (globalThis as { qaPressed?: boolean }).qaPressed = true;
    });
    watch.observe(document.body, { childList: true, subtree: true });
  });
  ask({ local_only: true });
  await prompt.waitFor();
  await page.waitForFunction(() => (globalThis as { qaPressed?: boolean }).qaPressed === true);
  await settled();
  assert.deepEqual(decided, [], "a key that lands on Approve as the prompt arrives approves nothing");
  assert.equal(await focus(page), "prompt", "over Settings the prompt takes the focus on its own surface, not on Approve");
  assert.equal(await prompt.getAttribute("role"), "group");
  assert.equal(await sentence.innerText(), "Hako's iPhone wants to add this PC to your account. Type 725 403 on Hako's iPhone, or check that Hako's iPhone shows the same number, then press Approve here.");
  // by what the PC said is left, though by this browser's clock the PC's expires_at is past
  const left = Number.parseInt(await prompt.locator('[data-testid="relay-pairing-left"]').innerText(), 10);
  assert.ok(left > 30 && left <= 90, `the seconds left follow left_ms, not this browser's clock: ${left}`);
  // nothing on the page reads the prompt as a dialog that covers it (ConnectPhoneDialog's and the drawer's
  // Escape, PANE_COVER_SELECTOR, the web popup's cover)
  assert.equal(await page.locator('[role="alertdialog"]').count(), 0, "the prompt is no alertdialog");
  assert.equal(await page.evaluate(() => document.querySelector(".relay-pairing-layer")?.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], dialog[open]') ?? null), null);
  assert.equal(await page.evaluate(() => document.querySelector('.relay-pairing-layer [role="dialog"], .relay-pairing-layer [role="alertdialog"], .relay-pairing-layer [aria-modal="true"], .relay-pairing-layer [role="menu"]')), null);

  // 2. Tab walks the prompt's two buttons although Settings holds a focus trap, then goes back to Settings:
  //    the prompt and its buttons follow Settings' own stops in its Tab round
  await page.keyboard.press("Tab");
  assert.equal(await focus(page), "prompt Approve", "Tab goes from the prompt to Approve, past Settings' trap");
  await page.keyboard.press("Tab");
  assert.equal(await focus(page), "prompt Decline");
  await page.keyboard.press("Tab");
  assert.ok((await focus(page)).startsWith("settings"), "Tab past Decline goes back to Settings, never nowhere");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focus(page), "prompt Decline", "Shift+Tab from Settings' first stop goes back into the prompt");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focus(page), "prompt");
  await page.keyboard.press("Shift+Tab");
  assert.ok((await focus(page)).startsWith("settings"), "Shift+Tab from the prompt goes to Settings' last stop, never to the page beneath");
  withdraw();
  await prompt.waitFor({ state: "detached" });

  // 2b. the focus in a field inside Settings: the prompt leaves it there, and Tab still reaches the prompt
  //     from Settings' round, on the prompt itself. The keys of that walk, pressed the moment the prompt
  //     is there (typed for the field), end on Approve and approve nothing
  const field = settings.locator("input:visible, select:visible, textarea:visible").first();
  await field.focus();
  assert.equal(await focus(page), "settings field");
  await page.evaluate(() => {
    const qa = globalThis as { qaWalk?: string[] };
    const watch = new MutationObserver(() => {
      if (document.querySelector(".relay-pairing-prompt") === null) return;
      watch.disconnect();
      const walk: string[] = [];
      // Settings' trap moves the focus itself on each Tab it hears, so a key event made here walks as a pressed one
      for (let step = 0; step < 400; step += 1) {
        const active = document.activeElement;
        if (active?.matches(".relay-pairing-prompt .btn-primary")) { (active as HTMLElement).click(); walk.push("pressed Approve"); break; }
        active?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
        const now = document.activeElement;
        walk.push(now === null || now === document.body ? "nothing" : now.matches(".relay-pairing-prompt") ? "prompt" : now.closest(".relay-pairing-prompt") !== null ? "prompt button" : now.closest(".settings-dialog") !== null ? "settings" : "elsewhere");
      }
      qa.qaWalk = walk;
    });
    watch.observe(document.body, { childList: true, subtree: true });
  });
  const inSettings = ask({ local_only: true });
  await prompt.waitFor();
  await page.waitForFunction(() => (globalThis as { qaWalk?: string[] }).qaWalk !== undefined);
  const walk = await page.evaluate(() => (globalThis as { qaWalk?: string[] }).qaWalk ?? []);
  await settled();
  assert.deepEqual(decided, [], "Tab and Enter typed for a field in Settings approve nothing");
  assert.deepEqual(walk.filter((at) => at !== "settings"), ["prompt", "prompt button", "pressed Approve"], `from a field in Settings, Tab stays in Settings until the prompt, then lands on the prompt before Approve: ${walk.join(", ")}`);
  assert.equal(await focus(page), "prompt Approve");
  // back in the field, the prompt still waiting: real Tab presses reach it, the last of them from Settings
  await field.focus();
  assert.equal(await focus(page), "settings field", "the waiting prompt does not take the focus back from the field");
  let presses = 0;
  while ((await focus(page)).startsWith("settings")) {
    assert.ok(++presses <= 400, "Tab from a field in Settings reaches the prompt");
    await page.keyboard.press("Tab");
  }
  assert.equal(await focus(page), "prompt", "Tab leaves Settings for the prompt itself, not for Approve or the page beneath");
  await page.keyboard.press("Tab");
  assert.equal(await focus(page), "prompt Approve");
  // its first second is over by now (the seconds shown have moved): Enter approves
  await page.waitForFunction(() => Number.parseInt(document.querySelector('[data-testid="relay-pairing-left"]')?.textContent?.trim() ?? "", 10) <= 88);
  await page.keyboard.press("Enter");
  await prompt.waitFor({ state: "detached" });
  assert.deepEqual(decided.splice(0), [{ id: inSettings.id, decision: "approve" }]);
  assert.ok((await focus(page)).startsWith("settings"), `the focus goes back to where Tab took it from in Settings once the prompt is gone: ${await focus(page)}`);
  await settings.locator("button:visible").first().focus();
  const first2 = ask({ local_only: true });
  await prompt.waitFor();
  assert.equal(await focus(page), "prompt");

  // 3. Escape on the prompt closes Settings as it does from inside it, and the prompt stays to be answered
  await prompt.focus();
  assert.equal(await focus(page), "prompt");
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "detached" });
  assert.equal(await prompt.count(), 1, "Escape leaves the prompt waiting");
  await settled();
  assert.deepEqual(decided, []);
  // once its first second is over, a key on Approve approves
  await page.waitForFunction(() => Number.parseInt(document.querySelector('[data-testid="relay-pairing-left"]')?.textContent?.trim() ?? "", 10) <= 88);
  await prompt.getByRole("button", { name: "Approve", exact: true }).focus();
  await page.keyboard.press("Enter");
  await prompt.waitFor({ state: "detached" });
  assert.deepEqual(decided, [{ id: first2.id, decision: "approve" }]);

  // 4. a field the person types in (a terminal's is a textarea) keeps the focus and its keys
  await page.evaluate(() => {
    const field = document.createElement("textarea");
    field.className = "qa-field";
    document.body.prepend(field);
    field.focus();
  });
  assert.equal(await focus(page), "field");
  const second = ask();
  await prompt.waitFor();
  assert.equal(await focus(page), "field", "a prompt that arrives leaves the focus in a field");
  assert.equal(await sentence.innerText(), "Hako's iPhone wants to pair through the relay. Approve it only if its screen shows 725 403");
  await page.keyboard.type("cd pro");
  assert.equal(await page.locator(".qa-field").inputValue(), "cd pro", "what is typed still reaches the field");
  // a shell's Tab goes on from the field in the page's own order, not into the prompt
  await page.keyboard.press("Tab");
  assert.ok(!(await focus(page)).startsWith("prompt"), "Tab typed in a field does not land in the prompt");
  // a pointer's click is aimed at the prompt: at once
  await prompt.getByRole("button", { name: "Decline", exact: true }).click();
  await prompt.waitFor({ state: "detached" });
  assert.deepEqual(decided.slice(1), [{ id: second.id, decision: "decline" }]);

  // 5. a label the device chose cannot cut the sentence
  await page.evaluate(() => (document.querySelector(".qa-field") as HTMLElement).focus());
  ask({ local_only: true, label: "evil\u0000{digits}" });
  await prompt.waitFor();
  const words = await sentence.innerText();
  assert.ok(words.endsWith("shows the same number, then press Approve here."), `the instruction stays whatever the label: ${JSON.stringify(words)}`);
  assert.equal(await prompt.locator("strong").count(), 1);
  withdraw();
  await prompt.waitFor({ state: "detached" });

  assert.deepEqual(errors, []);
  console.log("PASS: the PC's approval prompt takes the focus over Settings on its own surface, Tab reaches Approve and Decline and returns to Settings, a field in Settings keeps the focus and Tab still reaches the prompt from it, Escape leaves it waiting, keys typed as it arrives or in a field approve nothing, it is no dialog to the page, its seconds follow the PC, and a hostile label keeps the sentence whole");
} finally { await browser.close(); server.stop(true); }
