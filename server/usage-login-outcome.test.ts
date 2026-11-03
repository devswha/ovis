import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageLoginFollowed, UsageLoginPrompt } from "../shared/usage-login.ts";
import type { UsageReport } from "../shared/protocol.ts";
import { createServer } from "./index.ts";
import { UsageLoginService } from "./usage-login.ts";
import { UsageService, USAGE_PROVIDERS, type UsageContext } from "./usage.ts";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ovis-login-outcome-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
import { join } from "node:path";
if (process.argv.includes("--help")) { console.log("login"); process.exit(0); }
const home = process.env.CLAUDE_CONFIG_DIR;
process.stdout.write(await Bun.file(${JSON.stringify(join(import.meta.dir, "fixtures/usage-login/claude.pty"))}).text());
for await (const code of console) {
  if (code === "fail") process.exit(1);
  if (code === "noop") process.exit(0);
  // a signal ends it: a PTY host reports that as exit code 0
  if (code === "kill") process.kill(process.pid, "SIGKILL");
  await Bun.write(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: \`fixture-\${crypto.randomUUID()}\`, expiresAt: 9999999999999, subscriptionType: "max" } }));
  if (!await Bun.file(join(home, ".claude.json")).exists()) await Bun.write(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "added", emailAddress: "added@example.test" } }));
  // another home signed in meanwhile (another terminal): not this login's account
  if (code === "also-elsewhere") {
    await Bun.write(join(process.env.HOME, ".claude-unrelated", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-unrelated", expiresAt: 9999999999999 } }));
    await Bun.write(join(process.env.HOME, ".claude-unrelated", ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "unrelated", emailAddress: "unrelated@example.test" } }));
  }
  process.exit(0);
}
`, { mode: 0o755 });
  // signs in at once to what codex-plan.json names: "own" is the home Codex writes (CODEX_HOME, else ~/.codex)
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
import { join } from "node:path";
if (process.argv.includes("--help")) { console.log("--device-auth"); process.exit(0); }
process.stdout.write(await Bun.file(${JSON.stringify(join(import.meta.dir, "fixtures/usage-login/codex-device.pty"))}).text());
const plan = await Bun.file(join(process.env.HOME, "codex-plan.json")).json();
for (const { dir, email } of plan.write) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = [part({ alg: "none" }), part({ exp: 9999999999, nonce: crypto.randomUUID(), "https://api.openai.com/profile": { email }, "https://api.openai.com/auth": { chatgpt_account_user_id: email } }), "sig"].join(".");
  await Bun.write(join(dir === "own" ? process.env.CODEX_HOME ?? join(process.env.HOME, ".codex") : dir, "auth.json"), JSON.stringify({ tokens: { access_token: token } }));
}
process.exit(plan.exit);
`, { mode: 0o755 });
  for (const name of ["work", "home", "expired"]) {
    const dir = join(root, `.claude-${name}`);
    mkdirSync(dir);
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: name, emailAddress: `${name}@example.test` } }));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      accessToken: `fixture-${name}`, expiresAt: name === "expired" ? 1 : 9_999_999_999_999, subscriptionType: "max",
    } }));
  }
  const ctx: UsageContext = {
    home: root, env: {}, platform: "linux", now: () => 1_000,
    fetch: async () => Response.json({ five_hour: { utilization: 20 } }),
    keychain: async () => ({ status: "missing" }), run: async () => null, has: () => false,
  };
  const start = () => {
    const login = new UsageLoginService(root, { PATH: bin }, ctx);
    const server = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"),
      machines: false, registerBridge: false, sidecar: false, terminalAttach: false,
      herdrConfigPath: join(root, "herdr.toml"),
      usage: new UsageService(ctx, USAGE_PROVIDERS.filter((provider) => provider.id === "claude")),
      usageLogin: login,
    });
    servers.push(server);
    return { server, login, origin: `http://127.0.0.1:${server.port}` };
  };
  return { root, start };
}

/** A Codex sign-in runs to its end without a code: the fake signs in as codex-plan.json says. */
async function completeCodexLogin(host: ReturnType<ReturnType<typeof fixture>["start"]>, body: object) {
  const started = await fetch(`${host.origin}/api/usage/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, provider: "codex", follow: true }),
  });
  expect(started.status).toBe(200);
  const { login_id: id }: UsageLoginFollowed = await started.json();
  const cookie = started.headers.get("set-cookie")?.split(";")[0] ?? "";
  await host.login.settled(id);
  const prompt: UsageLoginPrompt = await (await fetch(`${host.origin}/api/usage/login/prompt?login=${id}`, { headers: { cookie } })).json();
  expect(prompt.ended).toBe(true);
  return prompt;
}

const codexAuth = (email: string) => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return JSON.stringify({ tokens: { access_token: [part({ alg: "none" }), part({ exp: 9_999_999_999, "https://api.openai.com/profile": { email }, "https://api.openai.com/auth": { chatgpt_account_user_id: email } }), "sig"].join(".") } });
};

async function completeLogin(host: ReturnType<ReturnType<typeof fixture>["start"]>, body: object, code: string) {
  const started = await fetch(`${host.origin}/api/usage/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, follow: true }),
  });
  expect(started.status).toBe(200);
  const { login_id: id }: UsageLoginFollowed = await started.json();
  const cookie = started.headers.get("set-cookie")?.split(";")[0] ?? "";
  const prompt = async (): Promise<UsageLoginPrompt> => (await fetch(`${host.origin}/api/usage/login/prompt?login=${id}`, { headers: { cookie } })).json();
  for (;;) {
    const changed = host.login.changed(id);
    const current = await prompt();
    if (current.wants_code) break;
    if (current.ended) throw new Error("The fixture exited before accepting a code");
    await changed;
  }
  const ended = host.login.settled(id);
  const response = await fetch(`${host.origin}/api/usage/login/code`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ login: id, code }),
  });
  expect(response.status).toBe(204);
  await ended;
  return prompt();
}

it("re-authenticates the expired account in its own home and reports it signed in", async () => {
  const { root, start } = fixture();
  const host = start();
  const other = readFileSync(join(root, ".claude-work", ".credentials.json"), "utf8");
  const result = await completeLogin(host, { provider: "claude", account: "claude:expired" }, "success");
  expect(result.succeeded).toBe(true);
  const report: UsageReport = await (await fetch(`${host.origin}/api/usage`)).json();
  expect(report.providers.find((account) => account.key === "claude:expired")?.problem).toBeNull();
  expect(readFileSync(join(root, ".claude-work", ".credentials.json"), "utf8")).toBe(other);
});

it("does not report a failed re-login as successful just because other accounts exist", async () => {
  const host = fixture().start();
  const result = await completeLogin(host, { provider: "claude", account: "claude:expired" }, "fail");
  expect(result.succeeded).toBe(false);
});

it("does not count an exit 0 that left the home's earlier sign-in as it was", async () => {
  const host = fixture().start();
  const result = await completeLogin(host, { provider: "claude", account: "claude:work" }, "noop");
  expect(result.succeeded).toBe(false);
});

it("does not count a CLI a signal ended, whose home still holds its earlier sign-in", async () => {
  const host = fixture().start();
  const result = await completeLogin(host, { provider: "claude", account: "claude:work" }, "kill");
  expect(result.succeeded).toBe(false);
});

it("names the account this login signed in, not one another home gained meanwhile", async () => {
  const host = fixture().start();
  const result = await completeLogin(host, { provider: "claude", name: "added" }, "also-elsewhere");
  expect(result.succeeded).toBe(true);
  expect(result.account).toBe("added@example.test");
});

it("reports a first Codex sign-in in its default home as signed in", async () => {
  const { root, start } = fixture();
  writeFileSync(join(root, "codex-plan.json"), JSON.stringify({ write: [{ dir: "own", email: "first@example.test" }], exit: 0 }));
  const result = await completeCodexLogin(start(), { default: true });
  expect(result.succeeded).toBe(true);
  expect(result.account).toBe("first@example.test");
});

it("signs a named Codex home in to its own account only", async () => {
  const { root, start } = fixture();
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "auth.json"), codexAuth("other@example.test"));
  writeFileSync(join(root, "codex-plan.json"), JSON.stringify({ write: [{ dir: "own", email: "team@example.test" }], exit: 0 }));
  const result = await completeCodexLogin(start(), { name: "team" });
  expect(result.succeeded).toBe(true);
  expect(result.account).toBe("team@example.test");
});

it("does not credit a Codex home another sign-in wrote while this one failed", async () => {
  const { root, start } = fixture();
  writeFileSync(join(root, "codex-plan.json"), JSON.stringify({ write: [{ dir: join(root, ".codex-elsewhere"), email: "unrelated@example.test" }], exit: 0 }));
  const result = await completeCodexLogin(start(), { name: "team" });
  expect(result.succeeded).toBe(false);
});
