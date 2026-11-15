import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matrixOptions, runMatrix } from "./herdr-core-agent-matrix.ts";

const WAIT_MS = 10_000;

/**
 * An Ovis server as the script sees it: the routes it calls, with a silent pane, and a record of what was asked. `hook`
 * is its alert destination (Settings -> Alerts -> Also send to); `fail` makes one route answer 500; `hold` keeps a
 * workspace creation unanswered until the test lets it go.
 */
function fakeOvis(options: { hook?: boolean; fail?: string; hold?: boolean } = {}) {
  const state = { hook: options.hook === true, puts: 0, deletes: 0, created: [] as Record<string, unknown>[], closed: [] as string[] };
  const created = Promise.withResolvers<void>();
  const putSeen = Promise.withResolvers<void>();
  const closedSeen = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, bun) {
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}`;
      if (url.pathname === "/ws") return bun.upgrade(request) ? undefined : new Response("no", { status: 400 });
      if (options.fail === route) return json({ error: { code: "boom" } }, 500);
      switch (route) {
        case "GET /api/alerts/webhook": return json({ configured: state.hook });
        case "PUT /api/alerts/webhook": state.puts++; state.hook = true; putSeen.resolve(); return json({ configured: true });
        case "DELETE /api/alerts/webhook": state.deletes++; state.hook = false; return new Response(null, { status: 204 });
        case "POST /api/workspace/create": {
          state.created.push(await request.json() as Record<string, unknown>);
          created.resolve();
          if (options.hold) await release.promise;
          return json({ workspace_id: "w-1", pane_id: "t9" });
        }
        case "POST /api/workspace/close": state.closed.push(String((await request.json() as { workspace_id: unknown }).workspace_id)); closedSeen.resolve(); return json({ ok: true });
        case "POST /api/pane/input": case "POST /api/pane/keys": return json({ ok: true });
        case "GET /api/pane/read": return json({ read: { text: "Do you want to proceed?\n 1. Yes\n 2. No\n" } });
        case "GET /api/session": return json({ snapshot: { panes: [{ pane_id: "t9", agent: null, agent_status: "unknown" }] } });
        case "GET /api/pane/prompt": return json({ prompt: null });
        case "GET /api/pane/conversation": return json({ source: "scrollback" });
        default: return json({ error: { code: "not_found" } }, 404);
      }
    },
    websocket: { message() {} },
  });
  return { url: `http://127.0.0.1:${server.port}`, state, created: created.promise,
    /** the workspaces the server holds now: made and not closed */
    open: () => state.created.length - state.closed.length, putSeen: putSeen.promise, closedSeen: closedSeen.promise, release: () => release.resolve(), stop: () => server.stop(true) };
}

function bounded<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`no ${label} within ${WAIT_MS} ms`)), WAIT_MS); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const dirs: string[] = [];
const servers: { stop(): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(options: Parameters<typeof fakeOvis>[0] = {}) {
  const fake = fakeOvis(options);
  servers.push(fake);
  const dir = mkdtempSync(join(tmpdir(), "matrix-test-"));
  dirs.push(dir);
  const args = ["--url", fake.url, "--scratch", dir, "--out", join(dir, "matrix.md")];
  return { fake, dir, args };
}
const quiet = () => {};

describe("who the matrix may start", () => {
  it("runs the silent stand-in alone by default", async () => {
    const { fake, args } = setup();
    const options = matrixOptions(args, {});
    if ("refused" in options) throw new Error(options.refused);
    expect(options.agents).toEqual(["silent"]);
    expect(await runMatrix(options, quiet)).toBe(0);
    expect(fake.state.created).toHaveLength(1);
    expect(fake.state.created[0]).not.toHaveProperty("agent");
  });

  it("refuses a real agent without a token, and takes none from the command line", () => {
    const { args } = setup();
    expect(matrixOptions([...args, "--agents", "claude"], {})).toHaveProperty("refused");
    expect(matrixOptions([...args, "--agents", "codex", "--token", "t"], {})).toHaveProperty("refused");
  });

  it("takes a real agent's token from a file or the environment", () => {
    const { args, dir } = setup();
    writeFileSync(join(dir, "token"), "from-file\n");
    expect(matrixOptions([...args, "--agents", "claude", "--token-file", join(dir, "token")], {})).toMatchObject({ token: "from-file", agents: ["claude"] });
    expect(matrixOptions([...args, "--agents", "claude"], { OVIS_MATRIX_TOKEN: "from-env" })).toMatchObject({ token: "from-env" });
  });

  it("refuses Codex in a scratch folder under /dev/shm, which its read-only sandbox does not have", () => {
    expect(matrixOptions(["--url", "http://127.0.0.1:1", "--scratch", "/dev/shm/x", "--out", "/tmp/m.md", "--agents", "codex"], { OVIS_MATRIX_TOKEN: "t" })).toHaveProperty("refused");
  });
});

describe("an interrupt from the command line", () => {
  it("closes a workspace whose creation answers after Ctrl-C, and removes its alert destination, before it exits", async () => {
    const { fake, args } = setup({ hold: true });
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "herdr-core-agent-matrix.ts"), ...args], {
      env: { ...process.env, OVIS_MATRIX_TOKEN: "" }, stdout: "pipe", stderr: "pipe",
    });
    // what the script says, as it says it: its line that it waits for the call in flight
    const waiting = Promise.withResolvers<void>();
    let said = "";
    void (async () => { for await (const chunk of child.stdout) { said += new TextDecoder().decode(chunk); if (said.includes("closing what the call in flight makes")) waiting.resolve(); } })();
    await bounded("the workspace creation at the server", fake.created);
    child.kill("SIGINT");
    // the script either waits for the answer (and says so) or has exited without it: the answer comes only then
    await bounded("the script waiting or ending", Promise.race([waiting.promise, child.exited]));
    fake.release();
    expect(await bounded("the script's exit", child.exited)).toBe(130);
    expect({ open: fake.open(), hook: fake.state.hook, deletes: fake.state.deletes }).toEqual({ open: 0, hook: false, deletes: 1 });
  });
});

describe("what the matrix leaves on the server", () => {
  it("refuses a server that already has an alert destination, and touches nothing there", async () => {
    const { fake, args } = setup({ hook: true });
    const options = matrixOptions(args, {});
    if ("refused" in options) throw new Error(options.refused);
    expect(await runMatrix(options, quiet)).toBe(2);
    expect(fake.state).toMatchObject({ hook: true, puts: 0, deletes: 0, created: [] });
  });

  it("leaves such a destination alone with --skip-alerts", async () => {
    const { fake, args } = setup({ hook: true });
    const options = matrixOptions([...args, "--skip-alerts"], {});
    if ("refused" in options) throw new Error(options.refused);
    expect(await runMatrix(options, quiet)).toBe(0);
    expect(fake.state).toMatchObject({ hook: true, puts: 0, deletes: 0 });
  });

  it("removes its own alert destination after the run", async () => {
    const { fake, args } = setup();
    const options = matrixOptions(args, {});
    if ("refused" in options) throw new Error(options.refused);
    await runMatrix(options, quiet);
    expect(fake.state).toMatchObject({ hook: false, puts: 1, deletes: 1, closed: ["w-1"] });
  });

  it("removes its destination and closes the workspace it started when the run fails midway", async () => {
    const { fake, args } = setup({ fail: "GET /api/session" });
    const options = matrixOptions(args, {});
    if ("refused" in options) throw new Error(options.refused);
    await runMatrix(options, quiet);
    expect(fake.state).toMatchObject({ hook: false, deletes: 1, closed: ["w-1"] });
  });

  it("removes its destination and closes a workspace answered late when it is interrupted", async () => {
    const { fake, args } = setup({ hold: true });
    const options = matrixOptions(args, {});
    if ("refused" in options) throw new Error(options.refused);
    const { promise: interrupted, resolve: interrupt } = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const run = runMatrix(options, (line) => { if (line.includes("closing what the call in flight makes")) waiting.resolve(); }, interrupted);
    await bounded("the workspace creation", fake.created);
    interrupt();
    await bounded("the run waiting for its call in flight", waiting.promise);
    // the cleanup ran, and the creation answers only now: the run closes what it made before it ends
    expect(fake.state).toMatchObject({ hook: false, deletes: 1, closed: [] });
    fake.release();
    expect(await bounded("the run's end", run)).toBe(130);
    expect(fake.state.closed).toEqual(["w-1"]);
  });
});
