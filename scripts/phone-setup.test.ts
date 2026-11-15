import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateStateDir } from "../server/update-state.ts";

const ROOT = join(import.meta.dir, "..");
let scratch: string;
let server: ReturnType<typeof Bun.serve>;
let served: boolean;
let paired: number;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "herdr-phone-setup-"));
  served = true; paired = 0;
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/health") return Response.json({ ok: true, herdr: { version: "0.9.3", protocol: 1 }, auth: { required: false, authenticated: true } });
    if (request.headers.get("authorization") !== "Bearer test-token") return new Response(null, { status: 401 });
    if (path === "/api/access") return Response.json({ port: server.port, tailscale: {
      state: "running", dns_name: "demo.example.ts.net", serving_url: served ? "https://demo.example.ts.net" : null,
      serve_command: "tailscale serve -bg http://127.0.0.1:7317", serve_url: "https://demo.example.ts.net",
    } });
    if (path === "/api/devices/pair/start") {
      paired++; expect(request.headers.get("x-herdr-machine")).toBe("1");
      return Response.json({ code: "123456", expires_at: new Date(Date.now() + 600_000).toISOString() });
    }
    return new Response(null, { status: 404 });
  } });
  mkdirSync(join(scratch, "config"));
  writeFileSync(join(scratch, "config", ".env"), `PORT=${server.port}\nOVIS_TOKEN=test-token\n`);
});
afterEach(() => { server.stop(true); rmSync(scratch, { recursive: true, force: true }); });
const env = () => ({
  ...process.env, HOST: "127.0.0.1", HERDR_PLUGIN_ROOT: ROOT,
  HERDR_PLUGIN_CONFIG_DIR: join(scratch, "config"), HERDR_PLUGIN_STATE_DIR: join(scratch, "plugin-state"), OVIS_STATE_DIR: join(scratch, "app-state"),
});
/**
 * Phone setup as its marketplace action runs it, in a pane: a terminal (a PTY is its stdin, stdout and stderr). Enter
 * is pressed once it asks for it. `out` is what the terminal showed, as plain lines (CR LF and OSC 8 links undone).
 */
async function run() {
  let shown = "";
  let entered = false;
  const decoder = new TextDecoder();
  // a terminal can hand over its last bytes after the child exited: what it showed is read once its stream ended
  let ended = (): void => undefined;
  const complete = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the terminal's output never ended: ${JSON.stringify(shown)}`)), 15_000);
    ended = () => { clearTimeout(timer); resolve(); };
  });
  const child = Bun.spawn([process.execPath, "scripts/plugin.ts", "phone-setup"], { cwd: ROOT, windowsHide: true, env: env(), terminal: { cols: 200, rows: 80, data: (terminal, bytes) => {
    shown += decoder.decode(bytes, { stream: true });
    if (!entered && shown.includes("Press Enter to finish")) { entered = true; terminal.write("\r"); }
  }, exit: () => ended() } });
  const [code] = await Promise.all([child.exited, complete]);
  const out = shown.replace(/\r\n/g, "\n").replace(/\x1b\]8;;[^\x07\x1b]*(?:\x1b\\|\x07)/g, "");
  return { out, err: out, code };
}

/** Phone setup with its output going to a pipe, as a log or a CI run would take it. */
async function piped() {
  const child = Bun.spawn([process.execPath, "scripts/plugin.ts", "phone-setup"], { cwd: ROOT, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: env() });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
}

it("prints the phone address, QR and expiring code without printing the token", async () => {
  const result = await run();
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain("https://demo.example.ts.net");
  expect(result.out).toContain("123 456");
  expect(result.out).toMatch(/[█▀▄]/);
  expect(result.out).not.toContain("test-token");
  expect(paired).toBe(1);
});

it("writes no pairing code where its output is not a terminal, and asks the PC for none", async () => {
  const result = await piped();
  expect(result.code).toBe(1);
  expect(result.err).toBe("Pairing a device with a code needs a terminal: the QR code and the code to type are a key to this PC, so they are never written to a pipe, a file or a log. Run ovis pair in a terminal (over ssh, run ssh -t).\n");
  expect(result.out).not.toContain("123 456");
  expect(paired).toBe(0);
});

it("shows the Tailscale command without running it", async () => {
  served = false;
  const result = await run();
  expect(result.code, result.err).toBe(0);
  expect(result.out).toContain("run this on the PC");
  expect(result.out).toContain("tailscale serve -bg");
  expect(result.out).toContain("123 456");
});

it("runs its own setup with an active release installed, never the release's copy: it shows a pairing code", async () => {
  const updates = updateStateDir(ROOT, server.port!, join(scratch, "app-state"));
  const release = join(updates, "release-test");
  mkdirSync(join(release, "scripts"), { recursive: true });
  writeFileSync(join(release, "scripts", "plugin.ts"), 'console.log("active release", process.argv[2], process.env.HERDR_PLUGIN_ROOT);');
  writeFileSync(join(release, "scripts", "plugin-link.ts"), "export function needsTerminal() {}\n");
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, windowsHide: true }).stdout.toString().trim();
  writeFileSync(join(updates, "current.json"), JSON.stringify({ source_revision: revision, directory: release }));
  const result = await run();
  expect(result.code, result.err).toBe(0);
  expect(result.out).not.toContain("active release");
  expect(result.out).toContain("123 456");
  expect(paired).toBe(1);
});
