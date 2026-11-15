/**
 * The smoke check of devices.ts (run by proof.ts as `devices`; the review of #90 asked for one): browser devices routed
 * into one world with no app site of its own. A page served from a shell folder at the app origin reads the world's
 * account service and opens a socket on the world's relay, both through the routes; a host outside the world is the
 * case built to break it (refused and logged).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromePath } from "../chrome-path.ts";
import { capture, DESKTOP, PHONE, worldDevices } from "./devices.ts";
import { describeSeen, leakTargets, probeLeaks, sealed } from "./leaks.ts";
import { passphraseFreeSignIn } from "./proof-signin.ts";
import { startWorld } from "./world.ts";

type Verdict = (claim: string, expected: "PASS" | "FAIL", ok: boolean, detail: string) => void;

const SHELL_PAGE = `<!doctype html><title>world devices smoke</title><p id="state">ready</p><script>
window.smoke = async (account, relay) => {
  const providers = await fetch(account + "/v1/providers").then((answer) => answer.status, (error) => "failed: " + error.message);
  const socket = await new Promise((resolve) => {
    const ws = new WebSocket(relay + "/v1/pair?nameplate=7K3&role=host&v=1");
    const timer = setTimeout(() => resolve("no answer in 10 s"), 10000);
    ws.onopen = () => { clearTimeout(timer); ws.close(); resolve("open"); };
    ws.onerror = () => { clearTimeout(timer); resolve("error"); };
  });
  const outside = await fetch("https://example.com/").then(() => "reached", () => "failed");
  return { providers, socket, outside };
};
</script>`;

export async function devicesProof(verdict: Verdict, scratchRoot: string, evidence: string, prefix: string): Promise<void> {
  const shell = join(scratchRoot, `${prefix}-devices-shell`);
  mkdirSync(shell, { recursive: true });
  writeFileSync(join(shell, "index.html"), SHELL_PAGE);
  // no app site in the world: devices.ts serves the app origin (https://app.ovis.sh by default) from the shell folder itself
  await using world = await startWorld({ name: `${prefix}dv`, scratchRoot, machines: [] });
  // the case for signin's check: a fake with no people file signs anyone in on its provider redirect
  const free = await passphraseFreeSignIn(world.description.account.address);
  verdict("a world without a people file: the fake refuses its passphrase-free sign-in (GET /v1/signin/github)", "FAIL", free.startsWith("403"), free);
  const devices = await worldDevices(world.description, { shellDir: shell });
  try {
    for (const [name, width] of [["P", PHONE], ["D", DESKTOP]] as const) {
      const device = await devices.device(name, width);
      const seen = await device.page.evaluate(([account, relay]) => (window as unknown as { smoke: (a: string, r: string) => Promise<Record<string, unknown>> }).smoke(account!, relay!), [world.description.account.url, world.description.relay.url]);
      await capture(device.page, join(evidence, "devices"), `${name}-${width}`);
      writeFileSync(join(evidence, "devices", `${name}-log.txt`), `${[...device.log, ...device.errors].join("\n")}\n`);
      verdict(`devices.ts ${width} px: the app origin from the shell folder, the world's account service (/v1/providers) and its relay (a socket opens), all through the routes`, "PASS",
        seen["providers"] === 200 && seen["socket"] === "open" && device.log.some((line) => line.includes("ACCOUNT GET /v1/providers -> 200")) && device.log.some((line) => line.includes(" WS ")),
        `${JSON.stringify(seen)}; ${device.log.filter((line) => / (ACCOUNT|WS) /.test(line)).join(" | ").slice(0, 300)}`);
      verdict(`devices.ts ${width} px: a host outside the world is reached (it must be refused and logged)`, "FAIL",
        seen["outside"] === "reached" || !device.log.some((line) => line.includes("BLOCKED GET https://example.com/")), device.log.filter((line) => line.includes("example.com")).join(" | "));
    }
    // WebSockets and WebRTC, refused at the same layer as fetch: counted at this PC's loopback, where they would arrive
    const targets = await leakTargets(["127.0.0.1"]);
    try {
      const device = await devices.device("L", PHONE);
      const seen = await probeLeaks(device.page, [...targets.ws, "wss://echo.websocket.org/"], targets.stun);
      verdict("devices.ts: a page opens no WebSocket outside the world (refused and logged by the tool) and sends no WebRTC UDP", "PASS",
        sealed(seen, targets) && device.log.some((line) => line.includes("BLOCKED WS wss://echo.websocket.org/")), `${describeSeen(seen, targets)}; ${device.log.filter((line) => line.includes("BLOCKED WS")).length} BLOCKED WS in its log`);
      // the case that shows the check can tell: this PC's Chrome with neither the routes nor the flag, on a plain page
      const plain = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
      try {
        const page = await plain.newPage();
        await page.goto(targets.page);
        const loose = await probeLeaks(page, targets.ws, targets.stun);
        verdict("the same check on this PC's Chrome with no routes and no WebRTC flag", "FAIL", sealed(loose, targets), describeSeen(loose, targets));
      } finally {
        await plain.close();
      }
    } finally {
      targets.close();
    }
  } finally {
    await devices.close();
  }
}
