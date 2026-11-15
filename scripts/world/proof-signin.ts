/**
 * The proof of B1-B4 (run by proof.ts as `signin`): a browser inside a world (no interception) signs a device in on
 * the fake's /link page with a passphrase, from a page of the world's app origin that makes the app copy's calls, and
 * a machine's `ovis add` is followed through its two QR codes, both read offline. Each claim with a case that breaks it.
 * Every step has a bound: one that does not end within it (or throws) keeps what the browser's pages showed, the
 * terminal's recording, the account service's and the proxy's logs and a browser trace in <evidence>/<run>/trip-<step>/,
 * and fails the run with where it stood. Nothing waits by sleeping: QR links are read as the terminal writes them.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { insideBrowser, type InsideDevice } from "./browser.ts";
import { capture, PHONE } from "./devices.ts";
import { docker, run } from "./docker.ts";
import { describeSeen, leakTargets, probeLeaks, sealed } from "./leaks.ts";
import { objectName } from "./plan.ts";
import { attachWorld, startWorld } from "./world.ts";

type Verdict = (claim: string, expected: "PASS" | "FAIL", ok: boolean, detail: string) => void;
export interface SignInRun { readonly verdict: Verdict; readonly say: (line: string) => void; readonly scratchRoot: string; readonly evidence: string; readonly prefix: string; readonly round: number }

const APP_PAGE = `<!doctype html><title>world app stand-in</title><p id="state">ready</p><script>
// once more after a failed fetch: Chrome on this PC drops requests in flight with ERR_NETWORK_CHANGED whenever another
// run makes or removes a docker network; a refusal (CORS, a dead host) fails both times. window.retried counts them.
window.retried = 0;
window.call = async (url, init) => { try { return await fetch(url, init); } catch { window.retried++; return await fetch(url, init); } };
window.signIn = async (account, label) => {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  const started = await (await call(account + "/v1/signin/ovis/device", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code_challenge: challenge, code_challenge_method: "S256", label }) })).json();
  window.poll = async () => (await call(account + "/v1/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: started.device_code, code_verifier: verifier }) })).json();
  return started;
};
</script>`;

/**
 * A sign-in with no passphrase at the world's account service (its own address, as the proxy would reach it): the
 * fake's provider redirect, which hands out a code at once unless a people file stands in front of it.
 */
export async function passphraseFreeSignIn(accountAddress: string): Promise<string> {
  const query = new URLSearchParams({ redirect_uri: "http://127.0.0.1:1/callback", response_mode: "query", state: "s", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256" });
  try {
    const answer = await fetch(`${accountAddress}/v1/signin/github?${query}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const location = answer.headers.get("location");
    return `${answer.status}${location !== null && new URL(location).searchParams.has("code") ? " with a sign-in code" : ""}`;
  } catch (error) {
    return `failed: ${(error as Error).message}`;
  }
}

/** How long one step may take: above Playwright's own 30 s, so its errors come first when it has one. */
const STEP_MS = 45_000;

/** `promise`, or the text "timed out" after `ms`: for reads made while keeping evidence, which must not hang either. */
async function settle<T>(ms: number, promise: Promise<T>): Promise<T | string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(`timed out after ${ms} ms`), ms); });
  try { return await Promise.race([promise.catch((error: Error) => `failed: ${error.message}`), late]); } finally { clearTimeout(timer); }
}

/**
 * The steps of one run, each bounded. When a step trips (its bound passes, or it throws), `keep` writes what stood into
 * trip-<step>/ and the step throws with that folder's name; the steps' timings go to steps.txt as they end.
 */
function stepper(dir: string, keep: (folder: string) => Promise<void>) {
  const lines: string[] = [];
  return {
    lines,
    async step<T>(name: string, work: () => Promise<T>, ms: number = STEP_MS): Promise<T> {
      const started = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`not within ${ms} ms`)), ms); });
      try {
        const value = await Promise.race([work(), late]);
        lines.push(`${new Date().toISOString().slice(11, 23)} ${name} ${Date.now() - started} ms`);
        return value;
      } catch (error) {
        const folder = join(dir, `trip-${name}`);
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "why.txt"), `${name} after ${Date.now() - started} ms: ${(error as Error).stack ?? error}\n`);
        lines.push(`${new Date().toISOString().slice(11, 23)} ${name} TRIPPED after ${Date.now() - started} ms: ${(error as Error).message.split("\n")[0]}`);
        await keep(folder);
        throw new Error(`step ${name} tripped after ${Date.now() - started} ms (${(error as Error).message.split("\n")[0]}); kept in ${folder}`);
      } finally {
        clearTimeout(timer);
        writeFileSync(join(dir, "steps.txt"), `${lines.join("\n")}\n`);
      }
    },
  };
}

/**
 * Clicks a control that submits a form and returns once the document the submission brings has loaded. Playwright's
 * click does not wait for the navigation it starts, so a read, count or screenshot right after it can meet the old page
 * or Chrome between documents ("Page.captureScreenshot: Unable to capture screenshot", seen in a run of 71b1b234,
 * owner-confirm, 17 ms after the confirm's POST was answered). The listener is on before the click: the next load is the
 * new document's.
 */
async function submit(tab: Page, selector: string): Promise<void> {
  const loaded = tab.waitForEvent("load");
  await tab.click(selector);
  await loaded;
}

/**
 * THE SIGN-IN HANG (1 run in 3 before): Page.close() sent within milliseconds of the /link confirm's POST navigation is
 * lost by Chrome about one time in four here: Target.closeTarget is answered, the tab never goes, it keeps answering,
 * and Playwright waits for its close with no timeout. The proof's flows therefore leave their tabs open. This check
 * keeps the cause in sight: a sign-in confirmed on a tab of its own and closed at once, up to 40 times, until a close
 * is lost (each close given 5 s). When Chrome stops losing them, the check says so.
 */
async function lostClose(browser: Awaited<ReturnType<typeof insideBrowser>>, account: string, passphrase: string): Promise<{ readonly tries: number; readonly hungAt: number | null; readonly url: string }> {
  const device = await browser.device("L", PHONE);
  for (let tryNumber = 1; tryNumber <= 40; tryNumber++) {
    const tab = await device.context.newPage();
    try {
      const started = await device.page.evaluate(([origin, label]) => (window as unknown as { signIn: (a: string, l: string) => Promise<Record<string, string>> }).signIn(origin!, label!), [account, "lost-close"]);
      await tab.goto(started["verification_uri_complete"]!);
      await tab.fill("input[name=passphrase]", passphrase);
      await tab.click("button[type=submit]");
      await tab.click("button[value=approve]");
    } catch {
      // a try that did not reach the confirm (a network change on this PC) says nothing about the close: the next one
      continue;
    }
    const closed = await settle(5000, tab.close().then(() => "closed"));
    if (closed !== "closed") return { tries: tryNumber, hungAt: tryNumber, url: `${tab.url()} (${String(await settle(3000, tab.evaluate(() => document.readyState)))})` };
  }
  return { tries: 40, hungAt: null, url: "" };
}

/**
 * Chrome on this PC fails requests in flight with ERR_NETWORK_CHANGED whenever a docker network of any run on it comes or
 * goes (seen in about one sign-in in twenty; the page then reads "A network change was detected"). That is this PC,
 * not the flow under test: a flow during which the device logged one is done once more, at most three times in all,
 * and each time is said. A flow that fails with no network change fails as it is.
 */
async function overNetworkChanges<T>(device: InsideDevice, what: string, say: (line: string) => void, work: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const seen = device.failed.length;
    const changed = () => device.failed.slice(seen).some((line) => line.includes("ERR_NETWORK_CHANGED"));
    try {
      const value = await work(attempt);
      if (!changed() || attempt === 3) return value;
    } catch (error) {
      if (!changed() || attempt === 3) throw error;
    }
    say(`${what}: Chrome reported ERR_NETWORK_CHANGED (a docker network came or went on this PC); once more (${attempt + 1} of 3)`);
  }
}

async function deviceSignIn(phone: InsideDevice, account: string, passphrase: string, dir: string, tag: string, step: ReturnType<typeof stepper>["step"]): Promise<{ started: Record<string, string>; token: Record<string, unknown> }> {
  const started = await step(`${tag}-start`, () => phone.page.evaluate(([origin, label]) => (window as unknown as { signIn: (a: string, l: string) => Promise<Record<string, string>> }).signIn(origin!, label!), [account, phone.name]));
  const tab = await step(`${tag}-tab`, () => phone.context.newPage());
  await step(`${tag}-open`, () => tab.goto(started["verification_uri_complete"]!));
  await step(`${tag}-passphrase`, async () => { await tab.fill("input[name=passphrase]", passphrase); await submit(tab, "button[type=submit]"); });
  await step(`${tag}-capture`, () => capture(tab, dir, `${tag}-link`));
  if (await tab.locator("button[value=approve]").count() > 0) await step(`${tag}-approve`, async () => { await submit(tab, "button[value=approve]"); await capture(tab, dir, `${tag}-done`); });
  // the tab stays open, as a person leaves it: a close right after the confirm's POST can be lost (lostClose)
  const token = await step(`${tag}-poll`, () => phone.page.evaluate(() => (window as unknown as { poll: () => Promise<Record<string, unknown>> }).poll()));
  return { started, token };
}

export async function signInProof({ verdict, say, scratchRoot, evidence, prefix, round }: SignInRun): Promise<void> {
  const files = join(scratchRoot, `${prefix}-signin-files`);
  mkdirSync(join(files, "app"), { recursive: true });
  writeFileSync(join(files, "app", "index.html"), APP_PAGE);
  const passphrase = `owner-${crypto.randomUUID()}`;
  writeFileSync(join(files, "people"), `owner:${passphrase}\nstranger:stranger-${crypto.randomUUID()}\n`);
  chmodSync(join(files, "people"), 0o600);
  const dir = join(evidence, `signin-r${round}`);
  mkdirSync(dir, { recursive: true });
  const world = await startWorld({ name: `${prefix}si${round}`, scratchRoot, people: join(files, "people"), trustCa: true,
    origins: ["app=https://app.world.test:9445"], sites: [`app=${join(files, "app")}`], machines: [{ name: "m1", engine: "herdr", start: "all" }] });
  let phone: InsideDevice | null = null;
  let terminal = false;
  const attached = attachWorld(world.name, scratchRoot);
  const keep = async (folder: string) => {
    const pages = phone?.context.pages() ?? [];
    const texts: string[] = [];
    for (const [index, page] of pages.entries()) {
      texts.push(`== page ${index}: ${page.url()}\n${String(await settle(5000, page.evaluate(() => document.body?.innerText ?? "(no body)")))}`);
      await settle(5000, page.screenshot({ path: join(folder, `page-${index}.png`) }));
    }
    writeFileSync(join(folder, "pages.txt"), `${texts.join("\n\n")}\n`);
    writeFileSync(join(folder, "browser-log.txt"), `${[...phone?.failed ?? [], ...phone?.errors ?? [], "== requests", ...phone?.requests() ?? []].join("\n")}\n`);
    if (phone) await settle(10_000, phone.context.tracing.stop({ path: join(folder, "trace.zip") }));
    writeFileSync(join(folder, "terminal.txt"), terminal ? String(await settle(10_000, attached.machine("m1").recording("add"))) : "(no terminal started yet)\n");
    for (const part of ["account", "tls"]) {
      const logs = await settle(10_000, run(["docker", "logs", "-t", objectName(world.name, part)]));
      writeFileSync(join(folder, `${part}.log`), typeof logs === "string" ? `${logs}\n` : `${logs.out}${logs.err}`);
    }
  };
  const { step } = stepper(dir, keep);
  const browser = await insideBrowser(attached.description);
  const ended = (what: string) => say(`signin r${round}: ${what}`);
  try {
    phone = await step("device", () => browser.device("P", PHONE));
    await phone.context.tracing.start({ snapshots: true, screenshots: true });
    const account = attached.description.account.url;
    const outside = await step("outside", () => phone!.page.evaluate(async () => { try { await fetch("https://example.com/"); return "reached"; } catch { return "failed"; } }));
    verdict("B1: a host outside the world does not resolve in the inside browser (and is logged)", "FAIL", outside === "reached" || !phone.failed.some((line) => line.includes("example.com")), phone.failed.filter((line) => line.includes("example.com")).join(" | "));
    const noCors = await step("cors", () => phone!.page.evaluate(async (origin) => { try { await fetch(`${origin}/link`); return "read"; } catch { return "blocked"; } }, account));
    verdict("B1: the browser itself enforces CORS (a cross-origin read of /link, which sends no CORS headers)", "FAIL", noCors === "read", noCors);
    // what the resolver rules do not cover: WebSockets by address and WebRTC's UDP, counted where they would arrive
    const gateway = await docker(["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}", world.description.network]).catch(() => "");
    const targets = await leakTargets(["127.0.0.1", ...(gateway !== "" ? [gateway] : [])]);
    try {
      const seen = await step("leaks", () => probeLeaks(phone!.page, [...targets.ws, "wss://echo.websocket.org/"], targets.stun), 30_000);
      verdict(`B1: the world's browser (a container on its sealed network) opens no WebSocket outside the world and sends no WebRTC UDP (to this PC's loopback${gateway !== "" ? ` and its address on the world's network, ${gateway}` : ""})`, "PASS", sealed(seen, targets), describeSeen(seen, targets));
    } finally {
      targets.close();
    }
    const device = phone;
    const tagged = (tag: string, attempt: number) => attempt === 1 ? tag : `${tag}-try${attempt}`;
    const wrong = await overNetworkChanges(device, "the wrong sign-in", say, (attempt) => deviceSignIn(device, account, "not-the-passphrase-at-all", dir, tagged("wrong", attempt), step));
    verdict("B2: a device signs in with a wrong passphrase", "FAIL", typeof wrong.token["access_token"] === "string", JSON.stringify(wrong.token).slice(0, 120));
    const right = await overNetworkChanges(device, "the owner's sign-in", say, (attempt) => deviceSignIn(device, account, passphrase, dir, tagged("owner", attempt), step));
    verdict("B2/B4: an attached world signs a device in on /link with the owner's passphrase (real CORS, no interception)", "PASS",
      typeof right.token["access_token"] === "string" && right.token["account"] === "owner" && right.started["verification_uri"] === `${account}/link`, `account ${String(right.token["account"])}, verification_uri ${right.started["verification_uri"]}`);
    const free = await step("passphrase-free", () => passphraseFreeSignIn(attached.description.account.address));
    verdict("B2: with a people file the fake refuses its passphrase-free sign-in (GET /v1/signin/github)", "PASS", free.startsWith("403"), free);
    const lost = await step("lost-close", () => lostClose(browser, account, passphrase), 120_000);
    verdict("the cause of the sign-in hang: a tab closed right after the /link confirm's POST always closes (up to 40 tries, 5 s each)", "FAIL", lost.hungAt === null, lost.hungAt === null ? `${lost.tries} tries, every close done` : `try ${lost.hungAt}: close not done within 5 s, the tab still answers on ${lost.url}`);
    const m1 = attached.machine("m1");
    await step("ovis-add", () => m1.terminal("add", "bun scripts/plugin.ts add"));
    terminal = true;
    const signInLink = await step("signin-qr", () => m1.qrLink("add", (link) => link.startsWith(`${account}/link?code=`), 40_000));
    verdict("B3: the sign-in QR code `ovis add` drew is read back as its link", "PASS", signInLink !== null, String(signInLink));
    if (signInLink !== null) {
      await overNetworkChanges(device, "the machine's sign-in on /link", say, async (attempt) => {
        const tab = await step(tagged("machine-tab", attempt), () => device.context.newPage());
        await step(tagged("machine-open", attempt), () => tab.goto(signInLink));
        await step(tagged("machine-passphrase", attempt), async () => { await tab.fill("input[name=passphrase]", passphrase); await submit(tab, "button[type=submit]"); });
        // once more after a network change: the first confirm may have reached the service, which then asks no more
        if (attempt > 1 && await tab.locator("button[value=approve]").count() === 0) return;
        await step(tagged("machine-approve", attempt), () => submit(tab, "button[value=approve]"));
      });
    }
    const pairing = await step("pairing-qr", () => m1.qrLink("add", (link) => link !== signInLink, 90_000), 95_000);
    writeFileSync(join(dir, "terminal.txt"), await m1.recording("add"));
    verdict("B3: after the machine's sign-in, the pairing QR code is read back as the app origin's /s/<id>/#offer= link", "PASS", pairing !== null && new RegExp(`^${browser.app}/s/[0-9a-f]+/#offer=`).test(pairing), String(pairing).slice(0, 120));
    if (pairing !== null) {
      await step("pairing-open", () => phone!.page.goto(pairing));
      await step("pairing-capture", () => capture(phone!.page, dir, "pairing-opened"));
    }
    writeFileSync(join(dir, "browser-log.txt"), [...phone.failed, ...phone.errors].join("\n"));
    await phone.context.tracing.stop();
  } finally {
    await settle(30_000, browser.close());
    const started = Date.now();
    ended("checks done, removing the world");
    await world.teardown();
    ended(`world removed in ${Date.now() - started} ms`);
  }
}

/**
 * A scripted member device with no browser (Machine.memberDevice, inside/member.ts) in a container of the world: it
 * signs in to the test account on /link with the owner's passphrase, pairs through the world's relay from the link
 * `ovis add` showed on m1, and calls m1's /api/account/link and /api/account/enroll. The case built to break it: a
 * device that skips the pairing (it signs in with a pairing it made up) is refused.
 */
export async function memberProof({ verdict, say, scratchRoot, evidence, prefix, round }: SignInRun): Promise<void> {
  const files = join(scratchRoot, `${prefix}-member-files`);
  mkdirSync(files, { recursive: true });
  const passphrase = `owner-${crypto.randomUUID()}`;
  writeFileSync(join(files, "people"), `owner:${passphrase}\n`);
  chmodSync(join(files, "people"), 0o600);
  const dir = join(evidence, `member-r${round}`);
  mkdirSync(dir, { recursive: true });
  const world = await startWorld({ name: `${prefix}mb${round}`, scratchRoot, people: join(files, "people"), trustCa: true,
    machines: [{ name: "m1", engine: "herdr", start: "all" }, { name: "d1", engine: "herdr", start: "none" }] });
  const attached = attachWorld(world.name, scratchRoot);
  const m1 = attached.machine("m1");
  const keep = async (folder: string) => {
    writeFileSync(join(folder, "terminal.txt"), String(await settle(10_000, m1.recording("add"))));
    const logs = await settle(10_000, run(["docker", "logs", "-t", objectName(world.name, "account")]));
    writeFileSync(join(folder, "account.log"), typeof logs === "string" ? `${logs}\n` : `${logs.out}${logs.err}`);
  };
  const { step } = stepper(dir, keep);
  try {
    const account = attached.description.account.url;
    await step("ovis-add", () => m1.terminal("add", "bun scripts/plugin.ts add"));
    const signInLink = await step("signin-qr", () => m1.qrLink("add", (link) => link.startsWith(`${account}/link?code=`), 40_000));
    // the machine's own sign-in is not under test here: the fake approves it as its link page would
    await step("machine-signin", () => attached.call("approveOnLinkPage", new URL(signInLink ?? account).searchParams.get("code") ?? "", "owner", "github"));
    const pairing = await step("pairing-qr", () => m1.qrLink("add", (link) => link !== signInLink && link.includes("#offer="), 90_000), 95_000);
    if (pairing === null) throw new Error("m1 showed no pairing link");
    const d1 = attached.machine("d1");
    const skipped = await step("skip", () => d1.memberDevice("skip", pairing, passphrase), 130_000);
    writeFileSync(join(dir, "skip.json"), `${JSON.stringify(skipped, null, 2)}\n`);
    const skipDone = skipped.steps.at(-1) ?? {};
    // refused by m1 itself (its AUTH answer), not by the client's own checks: any other end counts as getting through
    verdict("a device that skips the pairing (a pairing it made up) gets through to m1's account routes", "FAIL", !(skipDone["refused"] === true && /\bauth_failed\b/.test(String(skipDone["error"]))), JSON.stringify(skipDone).slice(0, 200));
    const member = await step("member", () => d1.memberDevice("member", pairing, passphrase), 130_000);
    writeFileSync(join(dir, "member.json"), `${JSON.stringify(member, null, 2)}\n`);
    const by = (name: string) => member.steps.find((line) => line["step"] === name) ?? {};
    const enrollment = by("enroll")["enrollment"] as { finished?: boolean } | null | undefined;
    verdict("a scripted member device signs in, pairs from `ovis add`'s link through the relay, links (/api/account/link) and enrolls (/api/account/enroll) m1", "PASS",
      member.code === 0 && by("signed-in")["account"] === "owner" && by("paired")["account_key"] === true && by("link")["status"] === 200 && enrollment?.finished === true && by("done")["member"] === true,
      `exit ${member.code}; ${member.steps.map((line) => JSON.stringify(line)).join(" ").slice(0, 600)}${member.code === 0 ? "" : ` stderr: ${member.err.trim().slice(-300)}`}`);
    writeFileSync(join(dir, "terminal.txt"), await m1.recording("add"));
  } finally {
    const started = Date.now();
    say(`member r${round}: checks done, removing the world`);
    await world.teardown();
    say(`member r${round}: world removed in ${Date.now() - started} ms`);
  }
}

/**
 * The real account service (ovis-sh/account, pull request 25 at afa04d4, from a clone of our own:
 * OVIS_ACCOUNT_REPO) as a world's account service: `bun run local --people` from the checkout mounted read-only, in
 * the sealed network (no route out). A person signs a device in through its own link page and its passphrase page,
 * in the browser inside the world; a wrong passphrase is the case built to break it.
 */
export async function realAccountProof({ verdict, say, scratchRoot, evidence, prefix, round }: SignInRun, accountRepo: string): Promise<void> {
  const files = join(scratchRoot, `${prefix}-real-files`);
  mkdirSync(join(files, "app"), { recursive: true });
  writeFileSync(join(files, "app", "index.html"), APP_PAGE);
  const passphrase = `owner-${crypto.randomUUID()}`;
  writeFileSync(join(files, "people"), `owner:${passphrase}\nstranger:stranger-${crypto.randomUUID()}\n`);
  chmodSync(join(files, "people"), 0o600);
  const dir = join(evidence, `real-account-r${round}`);
  mkdirSync(dir, { recursive: true });
  const head = Bun.spawnSync(["git", "-C", accountRepo, "rev-parse", "HEAD"]).stdout.toString().trim();
  const before = Bun.spawnSync(["git", "-C", accountRepo, "status", "--porcelain", "--ignored"]).stdout.toString();
  const started = Date.now();
  const world = await startWorld({ name: `${prefix}ra${round}`, scratchRoot, account: "real", accountRepo, people: join(files, "people"), trustCa: true,
    origins: ["app=https://app.world.test:9445"], sites: [`app=${join(files, "app")}`], machines: [] });
  say(`real account r${round}: the world with ovis-sh/account ${head.slice(0, 8)} was up after ${Date.now() - started} ms`);
  const attached = attachWorld(world.name, scratchRoot);
  let phone: InsideDevice | null = null;
  const keep = async (folder: string) => {
    for (const part of ["account", "tls"]) {
      const logs = await settle(10_000, run(["docker", "logs", "-t", objectName(world.name, part)]));
      writeFileSync(join(folder, `${part}.log`), typeof logs === "string" ? `${logs}\n` : `${logs.out}${logs.err}`);
    }
    writeFileSync(join(folder, "browser-log.txt"), `${[...phone?.failed ?? [], ...phone?.errors ?? [], "== requests", ...phone?.requests() ?? []].join("\n")}\n`);
    const texts: string[] = [];
    for (const [index, page] of (phone?.context.pages() ?? []).entries()) texts.push(`== page ${index}: ${page.url()}\n${String(await settle(5000, page.evaluate(() => document.body?.innerText ?? "(no body)")))}`);
    writeFileSync(join(folder, "pages.txt"), `${texts.join("\n\n")}\n`);
  };
  const { step } = stepper(dir, keep);
  const browser = await insideBrowser(attached.description);
  try {
    const account = attached.description.account.url;
    const device = await step("device", () => browser.device("P", PHONE));
    phone = device;
    const providers = await step("providers", () => device.page.evaluate(async (origin) => (await (window as unknown as { call: typeof fetch }).call(`${origin}/v1/providers`)).json(), account)) as Record<string, unknown>;
    verdict("real account: the service from a read-only checkout of afa04d4 starts in the sealed world and offers Google only (the people page), through its own CORS", "PASS",
      head.startsWith("afa04d4") && JSON.stringify(providers["providers"]) === '["google"]', `checkout ${head.slice(0, 12)}; /v1/providers ${JSON.stringify(providers)}`);
    const token = await step("test-token", () => attached.token("tester-1"));
    const pcs = await step("bearer", () => fetch(`${attached.description.account.address}/v1/pcs`, { headers: { authorization: `Bearer ${token}` } }).then((answer) => answer.status));
    verdict("real account: the world's control API mints a test token through /v1/test/token, and the service takes it", "PASS", typeof token === "string" && token.length > 20 && pcs === 200, `token of ${token.length} characters, GET /v1/pcs ${pcs}`);
    const signIn = async (tag: string, typed: string) => {
      const begun = await step(`${tag}-start`, () => device.page.evaluate(([origin, label]) => (window as unknown as { signIn: (a: string, l: string) => Promise<Record<string, string>> }).signIn(origin!, label!), [account, "world phone"]));
      const tab = await step(`${tag}-tab`, () => device.context.newPage());
      await step(`${tag}-link`, async () => { await tab.goto(begun["verification_uri_complete"] ?? `${account}/link`); await submit(tab, "button[name=provider][value=google]"); });
      await step(`${tag}-people`, async () => { await tab.fill("input[name=passphrase]", typed); await submit(tab, "button[type=submit]"); });
      const confirm = await tab.locator('form[action="/link/confirm"] button').count();
      await step(`${tag}-capture`, () => capture(tab, dir, `${tag}-after-passphrase`));
      if (confirm > 0) await step(`${tag}-confirm`, async () => { await submit(tab, 'form[action="/link/confirm"] button'); await capture(tab, dir, `${tag}-confirmed`); });
      const answer = await step(`${tag}-poll`, () => device.page.evaluate(() => (window as unknown as { poll: () => Promise<Record<string, unknown>> }).poll()));
      return { begun, answer };
    };
    const wrong = await overNetworkChanges(device, "the wrong sign-in (real account)", say, (attempt) => signIn(attempt === 1 ? "wrong" : `wrong-try${attempt}`, "not-the-passphrase-at-all"));
    verdict("real account: a device signs in with a wrong passphrase on the service's own people page", "FAIL", typeof wrong.answer["access_token"] === "string", JSON.stringify(wrong.answer).slice(0, 160));
    const right = await overNetworkChanges(device, "the owner's sign-in (real account)", say, (attempt) => signIn(attempt === 1 ? "owner" : `owner-try${attempt}`, passphrase));
    verdict("real account: a person signs a device in on the service's link page and people page with the owner's passphrase", "PASS",
      typeof right.answer["access_token"] === "string" && typeof right.answer["account"] === "string" && right.begun["verification_uri"] === `${account}/link`,
      `account ${String(right.answer["account"])}, provider ${String(right.answer["provider"])}, verification_uri ${right.begun["verification_uri"]}`);
    writeFileSync(join(dir, "browser-log.txt"), [...device.failed, ...device.errors].join("\n"));
    await keep(dir);
  } finally {
    await settle(30_000, browser.close());
    await world.teardown();
    const after = Bun.spawnSync(["git", "-C", accountRepo, "status", "--porcelain", "--ignored"]).stdout.toString();
    verdict("real account: the checkout is as it was (git status, ignored files included) after the run", "PASS", after === before, after === before ? `unchanged (${before.split("\n").filter(Boolean).length} ignored entries, node_modules)` : `before ${before} after ${after}`);
  }
}
