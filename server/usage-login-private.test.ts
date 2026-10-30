import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as herdr from "./herdr/client.ts";
import { UsageLoginService } from "./usage-login.ts";

/**
 * A sign-in the browser follows runs in a private terminal of the server's own (Bun.spawn's PTY), never in a
 * herdr pane, so no other device can read its sign-in address or the code typed into it. The stand-in CLIs
 * print what the real ones printed (server/fixtures/usage-login/*.pty) and read a pasted code like Claude's.
 */
const root = mkdtempSync(join(tmpdir(), "usage-login-private-"));
const bin = join(root, "bin");
const fixtures = join(import.meta.dir, "fixtures/usage-login");
const receipt = (name: string) => join(root, `${name}.receipt`);
const spies: { mockRestore(): void }[] = [];
let names = 0;

beforeAll(() => {
  mkdirSync(bin);
  // --help answers what the real ones list; a login prints its recorded screen, then waits as the real one does
  writeFileSync(join(bin, "claude"), `#!/bin/sh
case "$*" in *--help*) echo "login"; exit 0;; esac
echo "\${CLAUDE_CONFIG_DIR:-default}" > "${receipt("claude-home")}"
cat "${join(fixtures, "claude.pty")}"
IFS= read -r code
printf '%s' "$code" > "${receipt("claude-code")}"
echo "Login successful."
`, { mode: 0o755 });
  writeFileSync(join(bin, "codex"), `#!/bin/sh
case "$*" in *--help*) echo "--device-auth"; exit 0;; esac
cat "${join(fixtures, "codex-device.pty")}"
exec sleep 600
`, { mode: 0o755 });
  writeFileSync(join(bin, "grok"), "#!/bin/sh\necho --device-auth\n", { mode: 0o755 });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

/** herdr is never asked for a tab, a workspace or a key: each call fails the test that made it. */
function noHerdr(): string[] {
  const asked: string[] = [];
  for (const name of ["tabCreate", "workspaceCreate", "paneSendText", "paneSendKeys", "paneRead", "sessionSnapshot"] as const) {
    spies.push(spyOn(herdr, name).mockImplementation((async () => { asked.push(name); throw new Error(`herdr.${name} called`); }) as never));
  }
  return asked;
}

const post = (service: UsageLoginService, path: string, body: unknown) =>
  service.handlePrompt(new Request(`http://x/api/usage/login/${path}`, { method: "POST", body: JSON.stringify(body) }), false);
const read = (service: UsageLoginService, login: string, readOnly = false) =>
  service.handlePrompt(new Request(`http://x/api/usage/login/prompt?login=${encodeURIComponent(login)}`), readOnly);

async function start(service: UsageLoginService, body: Record<string, unknown>): Promise<Response> {
  return service.handle(new Request("http://x/api/usage/login", { method: "POST", body: JSON.stringify({ follow: true, ...body }) }));
}

/** Reads the login's prompt until `until` holds, within a bounded time: the CLI prints its screen as it starts. */
async function promptWhen(service: UsageLoginService, login: string, until: (prompt: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const prompt = (await (await read(service, login)).json()) as Record<string, unknown>;
    if (until(prompt)) return prompt;
    if (Date.now() > deadline) throw new Error(`the prompt never came: ${JSON.stringify(prompt)}`);
    await Bun.sleep(25);
  }
}

describe("a sign-in the browser follows", () => {
  it("runs in a private terminal: herdr opens no tab and no pane holds its address", async () => {
    const asked = noHerdr();
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    const started = await start(service, { provider: "codex", name: `work-${++names}` });
    expect(started.status).toBe(200);
    const body = (await started.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("pane_id");
    expect(body["login_id"]).toMatch(/^[0-9a-f-]{36}$/);
    const prompt = await promptWhen(service, body["login_id"] as string, (shown) => shown["user_code"] !== null);
    expect(prompt).toEqual({ provider: "codex", url: "https://auth.openai.com/codex/device", user_code: "PG8L-CV4AR", wants_code: false, ended: false });
    expect(asked).toEqual([]);
    await post(service, "cancel", { login: body["login_id"] });
  });

  it("answers only the browser that holds its id, and never a device that only watches", async () => {
    noHerdr();
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    const { login_id: login } = (await (await start(service, { provider: "codex", name: `work-${++names}` })).json()) as { login_id: string };
    expect((await read(service, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await read(service, login, true)).status).toBe(403);
    expect((await post(service, "code", { login: "00000000-0000-4000-8000-000000000000", code: "abc" })).status).toBe(404);
    await post(service, "cancel", { login });
  });

  it("types a pasted code into the CLI's own terminal, ends with it, and has the usage read again", async () => {
    noHerdr();
    let ended = 0;
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    service.onLoginEnded(() => { ended += 1; });
    const { login_id: login } = (await (await start(service, { provider: "claude", name: `work-${++names}` })).json()) as { login_id: string };
    const prompt = await promptWhen(service, login, (shown) => shown["wants_code"] === true);
    expect(prompt["url"]).toStartWith("https://claude.com/cai/oauth/authorize?");
    for (const shellish of ["touch${IFS}/tmp/x", "a;b", "$(id)", "a b"]) expect((await post(service, "code", { login, code: shellish })).status).toBe(400);
    expect((await post(service, "code", { login, code: "abc123#state-xyz" })).status).toBe(204);
    await promptWhen(service, login, (shown) => shown["ended"] === true);
    expect(readFileSync(receipt("claude-code"), "utf8")).toBe("abc123#state-xyz");
    expect(ended).toBe(1);
  });

  it("stops the CLI when the browser cancels, and frees its home for the next sign-in", async () => {
    noHerdr();
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    const first = (await (await start(service, { provider: "codex", default: true })).json()) as { login_id: string };
    expect((await start(service, { provider: "codex", default: true })).status).toBe(409);
    expect((await post(service, "cancel", { login: first.login_id })).status).toBe(204);
    expect(((await (await read(service, first.login_id)).json()) as { ended: boolean }).ended).toBe(true);
    const again = await start(service, { provider: "codex", default: true });
    expect(again.status).toBe(200);
    await post(service, "cancel", { login: ((await again.json()) as { login_id: string }).login_id });
  });

  it("signs in to the CLI's own home with its home variable removed", async () => {
    noHerdr();
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: "/elsewhere" });
    const { login_id: login } = (await (await start(service, { provider: "claude", default: true })).json()) as { login_id: string };
    await promptWhen(service, login, (shown) => shown["wants_code"] === true);
    expect(readFileSync(receipt("claude-home"), "utf8").trim()).toBe("default");
    await post(service, "cancel", { login });
  });

  it("follows only Claude Code and Codex", async () => {
    noHerdr();
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    expect((await start(service, { provider: "grok" })).status).toBe(400);
    expect(existsSync(receipt("grok"))).toBe(false);
  });
});
