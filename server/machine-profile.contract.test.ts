import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, paneRead } from "./herdr/client.ts";
import { bounded, deferred } from "./relay/test-helpers.ts";
import { updateStateDir } from "./update-state.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const root = resolve(import.meta.dir, "..");
const token = "machine-contract-owner";
const headers = { authorization: `Bearer ${token}`, "x-herdr-update": "1", "x-herdr-machine": "1" };
function state() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-machine-profile-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** `undefined` in `env` leaves that variable out of the server's environment. */
function launch(stateDir: string, env: Record<string, string | undefined> = {}) {
  const ready = deferred<string>();
  let output = "";
  let errors = "";
  const merged: Record<string, string | undefined> = { ...process.env, OVIS_PROFILE: "machine", OVIS_PREVIEW: "fleet", OVIS_RUNTIME: "herdr", OVIS_STATE_DIR: stateDir,
    HOME: stateDir, OVIS_TOKEN: token, PORT: "0", HOST: "127.0.0.1", HERDR_REMOTE_SOCKET: process.env["HERDR_SOCKET"] ?? "",
    OVIS_MANAGED: "0", OVIS_TAILSCALE_SERVE_ONLY: "0", OVIS_RELAY_URL: "wss://relay.invalid", ...env };
  const child = Bun.spawn([process.execPath, "server/main.ts", "serve"], {
    cwd: root, env: Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const read = async (stream: ReadableStream<Uint8Array>, standardError: boolean) => {
    for await (const chunk of stream) {
      const text = new TextDecoder().decode(chunk);
      output += text;
      if (standardError) errors += text;
      const match = /Ovis listening on (http:\/\/[^\s]+)/.exec(output);
      if (match?.[1]) ready.resolve(match[1]);
    }
  };
  const drained = Promise.all([read(child.stdout, false), read(child.stderr, true)]);
  const exited = child.exited.then(async (code) => { await drained; ready.reject(new Error(output || `Server exited ${code}`)); return code; });
  // A refused second start is observed through exited, not ready.
  void ready.promise.catch(() => undefined);
  cleanup.push(async () => { if (child.exitCode === null) child.kill(); await bounded(exited, 15_000); });
  return { child, ready: ready.promise, exited, output: () => output, errors: () => errors };
}

/** A refusal at the profile's start: exit 1 and one sentence on standard error, no stack or source excerpt. */
async function refused(server: ReturnType<typeof launch>): Promise<string> {
  expect(await bounded(server.exited, 20_000)).toBe(1);
  const sentence = server.errors().trim();
  expect(sentence).not.toContain("\n");
  expect(sentence).toMatch(/^[A-Z].*\.$/);
  return sentence;
}

it("binds the machine profile only to IPv4 loopback despite publishing settings", async () => {
  const dir = state();
  const herdr = join(dir, "bin", "herdr");
  const server = launch(dir, { HOST: "0.0.0.0", OVIS_IPV6_LOOPBACK: "1", OVIS_LAN_HTTPS: "1", OVIS_TAILSCALE_SERVE_ONLY: "1", OVIS_HERDR_BIN: herdr });
  const base = await bounded(server.ready, 20_000);
  expect(new URL(base).hostname).toBe("127.0.0.1");
  expect(server.output()).toContain(`herdr binary: ${herdr} (from OVIS_HERDR_BIN)\n`);
  const response = await fetch(`${base}/api/health`, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, machine_profile: { engine: "herdr" } });
  const direct = await fetch(`${base}/api/relay/direct`, { method: "POST", headers: { ...headers, origin: base, "content-type": "application/json" }, body: '{"on":true}' });
  expect(direct.status).toBe(409);
  expect(server.output()).not.toContain("LAN HTTPS on");
});

it.each(["environment", "saved"])("takes herdr-core selected by %s and runs no hc process while its core is absent", async (source) => {
  const dir = state();
  const calls = join(dir, "hc-calls");
  const hc = join(dir, "hc");
  writeFileSync(hc, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = --version ]; then echo 'hc 0.1.18'; else exit 1; fi\n`, { mode: 0o700 });
  if (source === "saved") writeFileSync(join(dir, "runtime-0.json"), JSON.stringify({ runtime: "herdr-core", previous: "herdr" }));
  // the core's own folders are this test's: no core of the user's is ever looked at. Under root's sticky
  // /tmp: a core socket is taken only on a path that no other account can write
  const core = mkdtempSync("/tmp/ovis-machine-core-absent-");
  cleanup.push(() => rmSync(core, { recursive: true, force: true }));
  const server = launch(dir, { OVIS_RUNTIME: source === "environment" ? "herdr-core" : "", OVIS_HC_BIN: hc, HC_SOCKET: join(core, "absent.sock"),
    XDG_RUNTIME_DIR: core, XDG_STATE_HOME: core, XDG_CONFIG_HOME: core });
  const base = await bounded(server.ready, 20_000);
  for (const path of ["/api/health", "/api/health?scope=bridge"]) {
    const response = await fetch(base + path, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, machine_profile: {
      engine: "herdr-core", runtime_down: true, reason: "herdr-core is not running on this machine for the selected session.",
    } });
  }
  // Request-triggered lookups must not construct a core connection either.
  await (await fetch(`${base}/api/session`, { headers })).text();
  expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").toBe("");
});

it("a second machine start on another port and canonical spelling leaves the first owner answering", async () => {
  const dir = state();
  const alias = `${dir}-alias`;
  symlinkSync(dir, alias, "junction");
  cleanup.push(() => rmSync(alias));
  const first = launch(dir, {});
  const base = await bounded(first.ready, 20_000);
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = reservation.port;
  reservation.stop();
  const second = launch(alias, { PORT: String(port) });
  const outcome = await bounded(Promise.race([second.exited.then((code) => ({ code })), second.ready.then(() => ({ code: 0 }), () => second.exited.then((code) => ({ code })))]), 20_000);
  expect(outcome.code).toBe(1);
  expect(await refused(second)).toContain("already owns this Ovis state directory");
  expect((await fetch(`${base}/api/health?scope=bridge`, { headers })).status).toBe(200);
});

it("refuses the machine profile without OVIS_PREVIEW=fleet before its state folder is touched, and starts it with the preview on", async () => {
  const dir = state();
  // a HOME of its own: Bun keeps its transpiler cache there, which is not the server's writing
  expect(await refused(launch(dir, { OVIS_PREVIEW: undefined, HOME: state() }))).toContain("OVIS_PREVIEW=fleet");
  expect(readdirSync(dir)).toEqual([]);
  const base = await bounded(launch(dir).ready, 20_000);
  const health = await (await fetch(`${base}/api/health`, { headers })).json() as Record<string, unknown>;
  expect(health["machine_profile"]).toBeDefined();
  expect(health["fleet_preview"]).toBe(true);
});

it("tells the fleet preview in an ordinary server's health only while OVIS_PREVIEW names it, and only to a caller that got in", async () => {
  for (const preview of [undefined, "fleet"]) {
    const base = await bounded(launch(state(), { OVIS_PROFILE: "", OVIS_PREVIEW: preview }).ready, 20_000);
    const answer = await fetch(`${base}/api/health`, { headers });
    expect(answer.status).toBe(200);
    const body = await answer.json() as Record<string, unknown>;
    expect(body["auth"]).toMatchObject({ authenticated: true });
    expect(body["fleet_preview"]).toBe(preview === undefined ? undefined : true);
    const stranger = await (await fetch(`${base}/api/health`)).json() as Record<string, unknown>;
    expect(stranger["auth"]).toMatchObject({ authenticated: false });
    expect(stranger).not.toHaveProperty("fleet_preview");
  }
});

it("ordinary servers on one state folder and different ports both answer without a lease", async () => {
  const dir = state();
  const first = launch(dir, { OVIS_PROFILE: "" });
  const one = await bounded(first.ready, 20_000);
  const second = launch(dir, { OVIS_PROFILE: "" });
  const two = await bounded(second.ready, 20_000);
  expect(one).not.toBe(two);
  for (const base of [one, two]) {
    const answer = await fetch(base + "/api/health?scope=bridge", { headers });
    expect(answer.status).toBe(200);
    expect(await answer.json()).not.toHaveProperty("machine_profile");
  }
  expect(existsSync(join(dir, "serve.lock"))).toBe(false);
});

/** A process that holds `lock` as an Ovis supervisor holds its supervisor.lock (server/supervisor.ts), until it is ended. */
async function supervisorRecord(lock: string) {
  // the supervisor makes its update state folder first, then takes the lock in it
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const holder = Bun.spawn([process.execPath, "-e", `const { acquireOwnerDirectory } = await import(${JSON.stringify(join(root, "server/owner-guard.ts"))});
acquireOwnerDirectory(${JSON.stringify(lock)}, { running: "running", starting: "starting" });
console.log("held");
setInterval(() => {}, 60_000);`], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const held = deferred<void>();
  void (async () => { for await (const chunk of holder.stdout) if (new TextDecoder().decode(chunk).includes("held")) held.resolve(); })();
  void holder.exited.then((code) => held.reject(new Error(`the record's holder exited ${code}`)));
  cleanup.push(async () => { holder.kill(); await bounded(holder.exited, 15_000); });
  await bounded(held.promise, 20_000);
  return holder;
}

it("refuses a state folder where an Ovis supervisor alive records itself, and starts once that owner is gone", async () => {
  const dir = state();
  // where a real Ovis records itself: <state folder>/updates/<checkout and port>/supervisor.lock
  const lock = join(updateStateDir(root, 7317, dir), "supervisor.lock");
  const holder = await supervisorRecord(lock);
  const before = readdirSync(dir).sort();
  // a HOME of its own: Bun itself writes into HOME, which the state folder is in the other launches
  const server = launch(dir, { HOME: state() });
  expect(await refused(server)).toContain(`An Ovis already runs on this state folder (lock ${lock}, owner pid ${holder.pid} generation `);
  expect(readdirSync(dir).sort()).toEqual(before);
  holder.kill();
  await bounded(holder.exited, 15_000);
  // the record names a dead owner now: it stays where it is and blocks nothing
  expect(existsSync(join(lock, "owner.json"))).toBe(true);
  const after = launch(dir);
  const base = await bounded(after.ready, 20_000);
  expect((await fetch(`${base}/api/health`, { headers })).status).toBe(200);
});

const spellings: [string, (home: string) => string | undefined][] = [
  ["OVIS_STATE_DIR unset", () => undefined],
  ["the default folder", (home) => join(home, ".config", "ovis")],
  ["the older default folder", (home) => join(home, ".config", "herdr-web-ui")],
  ["a trailing slash", (home) => `${join(home, ".config", "ovis")}/`],
  ["a path through ..", (home) => join(home, ".config", "herdr-web-ui", "..", "ovis")],
  ["a relative path", (home) => relative(root, join(home, ".config", "ovis"))],
  ["a symlink", (home) => { const alias = join(home, "alias"); symlinkSync(join(home, ".config", "ovis"), alias, "junction"); return alias; }],
];
it.each(spellings)("refuses a default Ovis state folder named by %s and writes nothing there", async (_, spelling) => {
  const home = state();
  // the folders an own Ovis keeps its state in
  for (const name of ["ovis", "herdr-web-ui"]) {
    mkdirSync(join(home, ".config", name), { recursive: true });
    writeFileSync(join(home, ".config", name, "devices.json"), "{}");
  }
  const server = launch(home, { HOME: home, XDG_CONFIG_HOME: undefined, OVIS_STATE_DIR: spelling(home) });
  expect(await refused(server)).toBe("The machine profile does not run on a default Ovis state folder, so no server was started; name a folder of its own with OVIS_STATE_DIR.");
  for (const name of ["ovis", "herdr-web-ui"]) expect(readdirSync(join(home, ".config", name))).toEqual(["devices.json"]);
});

it("removes its lease and the recorded listener when stopped cleanly", async () => {
  const dir = state();
  const server = launch(dir);
  const base = await bounded(server.ready, 20_000);
  expect(JSON.parse(readFileSync(join(dir, "serve.lock", "http.json"), "utf8"))).toEqual({ port: Number(new URL(base).port), hostname: "127.0.0.1" });
  server.child.kill("SIGTERM");
  expect(await bounded(server.exited, 20_000)).toBe(0);
  expect(existsSync(join(dir, "serve.lock"))).toBe(false);
});

it("names HERDR_SOCKET when the socket it gives cannot be used, and says which herdr it runs", async () => {
  const dir = state();
  const server = launch(dir, { HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "", HERDR_SOCKET: "relative/herdr.sock", OVIS_HERDR_BIN: "" });
  const base = await bounded(server.ready, 20_000);
  expect(server.output()).toMatch(/herdr binary: [^\n]+ \(from PATH\)\n/);
  const response = await fetch(`${base}/api/health`, { headers });
  expect(await response.json()).toMatchObject({ machine_profile: { runtime_down: true, reason: "HERDR_SOCKET must be an absolute path ending in /herdr.sock" } });
});

it("keeps authenticated server health available while the selected classic engine is absent", async () => {
  const dir = state();
  const missing = join(dir, "herdr", "sessions", "absent", "herdr.sock");
  const server = launch(dir, { HERDR_REMOTE_SOCKET: missing });
  const base = await bounded(server.ready, 20_000);
  const response = await fetch(`${base}/api/health`, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, auth: { authenticated: true }, machine_profile: { engine: "herdr", runtime_down: true, reason: "herdr is not running for the selected session" } });

});

const restricted = [
  "/api/herdr/update", "/api/runtime", "/api/runtime/move", "/api/runtime/move/install",
  "/api/runtime/move/stop", "/api/runtime/move/stop-all", "/api/runtime/move/start", "/api/runtime/move/cancel",
  "/api/portal", "/api/portal/start", "/api/relay/direct", "/api/machines", "/api/machines/ssh-candidates",
  "/api/fleet/machines", "/api/fleet/invites", "/api/fleet/restore/confirm", "/api/bridge",
];
it.each(restricted)("refuses %s even to an owner in the machine profile", async (path) => {
  const options = { profile: "machine" as const, stateDir: state(), port: 0, hostname: "127.0.0.1", token, tailscaleOwner: null, sidecar: false };
  const server = createServer(options);
  cleanup.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  const response = await fetch(base + path, { method: "POST", headers: { ...headers, origin: base, "content-type": "application/json" }, body: '{}' });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "machine_profile" } });
});

it.each(["", "?scope=bridge"])("gives an unknown caller only plain liveness at /api/health%s", async (query) => {
  const options = { profile: "machine" as const, stateDir: state(), port: 0, hostname: "127.0.0.1", token, tailscaleOwner: null, sidecar: false };
  const server = createServer(options);
  cleanup.push(() => server.stop());
  const response = await fetch(`http://127.0.0.1:${server.port}/api/health${query}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

/** A profile server, and beside it an ordinary one with the same options as the control: main's door. */
function pair(options: NonNullable<Parameters<typeof createServer>[0]>) {
  const profile = createServer({ profile: "machine", stateDir: state(), port: 0, hostname: "127.0.0.1", sidecar: false, ...options });
  const ordinary = createServer({ stateDir: state(), port: 0, hostname: "127.0.0.1", sidecar: false, ...options });
  cleanup.push(() => profile.stop(), () => ordinary.stop());
  return { profile: profile.port, ordinary: ordinary.port };
}

it("closes the pairing gate from the profile's first answer", async () => {
  const { profile, ordinary } = pair({ token: "", tailscaleOwner: null });
  const first = await (await fetch(`http://127.0.0.1:${profile}/api/health`)).json();
  expect(first).toMatchObject({ auth: { via: "local" }, security: { pairing_gate: "closed" } });
  expect(await (await fetch(`http://127.0.0.1:${ordinary}/api/health`)).json()).toMatchObject({ security: { pairing_gate: "open" } });
});

it("lets a DNS-rebinding page in nowhere before the relay was ever on, while this PC itself still gets in", async () => {
  const { profile, ordinary } = pair({ token: "", tailscaleOwner: null });
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", { label: "ovis-test-machine-door", cwd: root, focus: false });
  cleanup.push(async () => { await herdrRpc("workspace.close", { workspace_id: created.workspace.workspace_id }); });
  const paneId = created.root_pane.pane_id;
  // the page's own name as Host, its own origin, no Tailscale login to compare with
  const page = (port: number) => ({ host: `evil.example:${port}`, origin: `http://evil.example:${port}` });
  // control: main's ordinary server lets a request a proxy on this PC forwarded in as an open install; the profile does not
  const forwarded = { "x-forwarded-for": "203.0.113.7" };
  expect((await fetch(`http://127.0.0.1:${ordinary}/api/session`, { headers: forwarded })).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${profile}/api/session`, { headers: forwarded })).status).toBe(401);
  // the page's own name from loopback is a rebound name on main's server too (#3876): it is asked to pair
  expect((await fetch(`http://127.0.0.1:${ordinary}/api/session`, { headers: page(ordinary) })).status).toBe(401);
  expect((await (await fetch(`http://127.0.0.1:${ordinary}/api/health`, { headers: page(ordinary) })).json()).auth).toMatchObject({ authenticated: false, reason: "pairing_required" });
  expect((await fetch(`http://127.0.0.1:${profile}/api/session`, { headers: page(profile) })).status).toBe(401);
  const typed = await fetch(`http://127.0.0.1:${profile}/api/pane/input`, { method: "POST", headers: { ...page(profile), "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId, text: "FIX80_REBIND" }) });
  expect(typed.status).toBe(401);
  const socket = await fetch(`http://127.0.0.1:${profile}/ws`, { headers: { ...page(profile), connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
  expect(socket.status).toBe(401);
  // this PC itself types next; once its text is in the pane, the page's would have been there before it
  const own = await fetch(`http://127.0.0.1:${profile}/api/pane/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId, text: "FIX80_OWNER" }) });
  expect(own.status).toBe(200);
  const deadline = Date.now() + 15_000;
  let text = "";
  while (!text.includes("FIX80_OWNER")) {
    if (Date.now() > deadline) throw new Error(`the owner's text never reached the pane: ${text}`);
    text = (await paneRead({ paneId, source: "recent", format: "text", lines: 200 })).text ?? "";
    if (!text.includes("FIX80_OWNER")) await Bun.sleep(25);
  }
  expect(text).not.toContain("FIX80_REBIND");
});

it("lets nobody in by a Tailscale identity header, the machine's own login included", async () => {
  const { profile, ordinary } = pair({ token: "", tailscaleOwner: "owner@example.com" });
  const identity = { "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.7" };
  // control: main admits it "via tailscale"
  const admitted = await fetch(`http://127.0.0.1:${ordinary}/api/health`, { headers: identity });
  expect(await admitted.json()).toMatchObject({ auth: { authenticated: true, via: "tailscale" } });
  expect((await fetch(`http://127.0.0.1:${profile}/api/session`, { headers: identity })).status).toBe(401);
  const health = await fetch(`http://127.0.0.1:${profile}/api/health`, { headers: identity });
  expect(await health.text()).toBe('{"ok":true}');
});

it("treats the bridge token as nobody in the profile", async () => {
  const bridgeToken = "machine-contract-bridge-token";
  const { profile, ordinary } = pair({ token, bridgeToken, tailscaleOwner: null });
  const bearer = { authorization: `Bearer ${bridgeToken}` };
  // control: main's connection server reads this PC's session with it
  expect((await fetch(`http://127.0.0.1:${ordinary}/api/session`, { headers: bearer })).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${profile}/api/session`, { headers: bearer })).status).toBe(401);
  expect(await (await fetch(`http://127.0.0.1:${profile}/api/health?scope=bridge`, { headers: bearer })).text()).toBe('{"ok":true}');
});
