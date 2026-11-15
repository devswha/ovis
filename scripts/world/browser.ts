/**
 * B1: a browser INSIDE a world. Chromium runs in a container of its own on the world's sealed network (the image's
 * Playwright Chromium, served by inside/browser.ts) and this process drives it over that network: its pages are where
 * the world's machines are, and what a page can reach is what that network reaches. On top of that, Chromium resolves
 * the world's origin hosts to the world's TLS proxy and every other name to nothing, accepts the world's leaf
 * certificate by its key, and sends no UDP that does not go through a proxy (no WebRTC, no STUN). There is NO route
 * interception: the app's own page policy, the account service's own CORS answers and its redirects are what a test
 * sees, as a phone would. Each failed request is logged. For a world without an app site, devices.ts remains.
 *   const browser = await insideBrowser(world.description); const phone = await browser.device("P", PHONE);
 */
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { docker, run, startContainer } from "./docker.ts";
import { LABEL, PLAN_FILE, objectName, savedPlan } from "./plan.ts";
import { IMAGE, TOOL_DIR } from "./stage.ts";
import type { WorldDescription } from "./world.ts";

export interface InsideDevice {
  readonly name: string; readonly context: BrowserContext; readonly page: Page; readonly failed: string[]; readonly errors: string[];
  /** every address the device asked for, refused ones included, in order */
  requests(): readonly string[];
  offline(on: boolean): Promise<void>;
}
export interface InsideBrowser { readonly browser: Browser; readonly app: string; readonly container: string; device(name: string, width: number, start?: string): Promise<InsideDevice>; close(): Promise<void> }

/** The hosts the world answers for, from what its machines are pointed at. */
export function worldHosts(world: WorldDescription): string[] {
  return [...new Set(Object.values(world.origins).map((origin) => new URL(origin.replace(/^wss:/, "https:")).hostname))];
}

/** Chrome's resolver rules: the world's hosts go to its proxy, every other name fails to resolve. */
export function resolverRules(hosts: readonly string[], proxy: string): string {
  return [...hosts.map((host) => `MAP ${host} ${proxy}`), "MAP * ~NOTFOUND"].join(", ");
}

/** The base64 SHA-256 of a certificate's public key, the form --ignore-certificate-errors-spki-list takes. */
export function spkiHash(pem: string): string {
  const key = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(key).digest("base64");
}

/** No UDP but through a proxy: WebRTC gathers no candidate and sends no STUN (devices.ts takes it too). */
export const NO_WEBRTC_UDP = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";

/** Chromium's flags for a world's browser. */
export function insideArgs(world: WorldDescription, leafPem: string): string[] {
  return ["--no-sandbox", "--disable-dev-shm-usage", `--host-resolver-rules=${resolverRules(worldHosts(world), world.tls)}`,
    `--ignore-certificate-errors-spki-list=${spkiHash(leafPem)}`, NO_WEBRTC_UDP];
}

export async function insideBrowser(world: WorldDescription): Promise<InsideBrowser> {
  const app = world.origins["WORLD_APP_URL"];
  if (app === undefined) throw new Error("this world serves no app (--origin app=… --site app=…): use devices.ts");
  const plan = savedPlan(readFileSync(join(world.scratch, PLAN_FILE), "utf8"));
  const secret = randomBytes(24).toString("hex");
  const container = objectName(world.name, `b_${randomBytes(3).toString("hex")}`);
  // a container of the world: its band, its deadline, its owner's label, so the world's teardown removes it too
  await startContainer({ name: container, image: IMAGE, network: world.network, cpus: plan.cpus, memory: "2g", deadline: world.expires,
    labels: { [LABEL]: world.name, [`${LABEL}.owner`]: world.owner, [`${LABEL}.role`]: "browser" },
    mounts: [`${plan.repo}:/opt/ovis:ro`, `${TOOL_DIR}:/opt/world:ro`],
    env: { WORLD_REPO: "/opt/ovis", WORLD_BROWSER_ARGS: JSON.stringify(insideArgs(world, readFileSync(join(world.scratch, "certs", "cert.pem"), "utf8"))) },
    secrets: { WORLD_BROWSER_SECRET: secret }, extra: ["--shm-size=512m"],
    command: ["bun", "/opt/world/inside/browser.ts"] });
  try {
    const ip = await docker(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container]);
    // its server says when it listens: read off its log as it comes, bounded, no polling
    const ready = await readyLine(container, 60_000);
    if (!ready.ok) throw new Error(`${container}: its browser did not say it was ready within 60 s: ${ready.log.slice(-400)}`);
    const browser = await chromium.connect(`ws://${ip}:9323/${secret}`, { timeout: 30_000 });
    return insideDevices(browser, app, container);
  } catch (error) {
    await run(["docker", "rm", "-f", container]);
    throw error;
  }
}

/** Follows a container's log until its `ready` line, or `ms`, or the container's end. */
async function readyLine(container: string, ms: number): Promise<{ readonly ok: boolean; readonly log: string }> {
  const logs = Bun.spawn(["docker", "logs", "-f", container], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => logs.kill(), ms);
  let log = "";
  const decoder = new TextDecoder();
  try {
    const errors = new Response(logs.stderr).text();
    for await (const chunk of logs.stdout) {
      log += decoder.decode(chunk, { stream: true });
      if (/"event":"ready"/.test(log)) return { ok: true, log };
    }
    return { ok: false, log: log + await errors };
  } finally {
    clearTimeout(timer);
    logs.kill();
  }
}

function insideDevices(browser: Browser, app: string, container: string): InsideBrowser {
  async function device(name: string, width: number, start: string = app): Promise<InsideDevice> {
    const mobile = width < 600;
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, locale: "en-US", colorScheme: "dark" });
    const failed: string[] = [];
    const asked: string[] = [];
    context.on("request", (request) => asked.push(`${request.method()} ${request.url()}`));
    const errors: string[] = [];
    const stamp = () => new Date().toISOString().slice(11, 23);
    context.on("requestfailed", (request) => failed.push(`${stamp()} FAILED ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`));
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => errors.push(`${stamp()} ${error.message}`));
    await page.goto(start);
    return { name, context, page, failed, errors, requests: () => [...asked], offline: (on) => context.setOffline(on) };
  }
  const close = async () => {
    await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 15_000))]);
    await run(["docker", "rm", "-f", container]);
  };
  return { browser, app, container, device, close };
}
