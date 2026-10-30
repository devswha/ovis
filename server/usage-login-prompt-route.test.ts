import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as herdr from "./herdr/client.ts";
import { UsageLoginService } from "./usage-login.ts";

const root = mkdtempSync(join(tmpdir(), "usage-login-prompt-"));
const bin = join(root, "bin");
const codexScreen = readFileSync(join(import.meta.dir, "fixtures/usage-login/codex-device.recent_unwrapped.txt"), "utf8");
const spies: { mockRestore(): void }[] = [];
const typed: { pane: string; text: string }[] = [];
const keys: { pane: string; keys: string[] }[] = [];
let screen = codexScreen;
let launches = 0;

beforeAll(() => {
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\necho --device-auth\n", { mode: 0o755 });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho login\n", { mode: 0o755 });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); typed.length = 0; keys.length = 0; screen = codexScreen; });

function stubHerdr(): void {
  spies.push(
    spyOn(herdr, "sessionSnapshot").mockResolvedValue({ workspaces: [{ workspace_id: "w1" }], panes: [{ pane_id: "w1:p9", terminal_id: "t9" }] } as never),
    spyOn(herdr, "tabCreate").mockResolvedValue({ root_pane: { pane_id: "w1:p9", terminal_id: "t9" }, tab: { workspace_id: "w1" } } as never),
    spyOn(herdr, "paneSendText").mockImplementation(async (pane: string, text: string) => { typed.push({ pane, text }); return undefined as never; }),
    spyOn(herdr, "paneSendKeys").mockImplementation(async (pane: string, sent: string[]) => { keys.push({ pane, keys: sent }); return undefined as never; }),
    spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: screen }) as never),
  );
}

/** A service that has launched a sign-in in pane w1:p9, as Add account → On this PC does. */
async function launched(provider: "claude" | "codex" = "codex"): Promise<UsageLoginService> {
  stubHerdr();
  const service = new UsageLoginService(root, { PATH: bin });
  const started = await service.handle(new Request("http://x/api/usage/login", { method: "POST", body: JSON.stringify({ provider, name: `work-${++launches}` }) }));
  expect(started.status).toBe(200);
  typed.length = 0;
  return service;
}

const prompt = (service: UsageLoginService, pane: string, readOnly = false) =>
  service.handlePrompt(new Request(`http://x/api/usage/login/prompt?pane=${encodeURIComponent(pane)}`), readOnly);
const code = (service: UsageLoginService, body: unknown) =>
  service.handlePrompt(new Request("http://x/api/usage/login/code", { method: "POST", body: JSON.stringify(body) }), false);

describe("a first sign-in, in the agent's own home", () => {
  it("runs the CLI with its home variable removed, so the plain command finds the sign-in", async () => {
    stubHerdr();
    const service = new UsageLoginService(root, { PATH: bin });
    const started = await service.handle(new Request("http://x/api/usage/login", { method: "POST", body: JSON.stringify({ provider: "codex", default: true }) }));
    expect(started.status).toBe(200);
    expect(typed.map((entry) => entry.text).join("")).toBe(`exec 'env' '-u' 'CODEX_HOME' '${join(bin, "codex")}' 'login' '--device-auth'\n`);
    expect((await prompt(service, "w1:p9")).status).toBe(200);
  });

  it("asks before replacing a sign-in the PC already has, and takes no name", async () => {
    stubHerdr();
    const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/profile": { email: "codex@example.test" } })).toString("base64url");
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: `header.${claims}.signature` } }));
    try {
      const service = new UsageLoginService(root, { PATH: bin });
      const ask = (body: unknown) => service.handle(new Request("http://x/api/usage/login", { method: "POST", body: JSON.stringify(body) }));
      const refused = await ask({ provider: "codex", default: true });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("account_confirmation_required");
      expect((await ask({ provider: "codex", default: true, name: "work" })).status).toBe(400);
      expect((await ask({ provider: "grok", default: true })).status).toBe(400);
      expect(typed).toEqual([]);
    } finally {
      rmSync(join(root, ".codex"), { recursive: true, force: true });
    }
  });
});

describe("the sign-in prompt of a login this server launched", () => {
  it("answers the page to open and the one-time code the CLI printed", async () => {
    const service = await launched();
    const response = await prompt(service, "w1:p9");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "codex", url: "https://auth.openai.com/codex/device", user_code: "PDLB-SLDUA", wants_code: false, ended: false });
  });

  it("says when the login has ended, and reads its pane no more", async () => {
    const service = await launched();
    service.ended("w1:p9");
    const read = herdr.paneRead as unknown as { mock: { calls: unknown[] } };
    const before = read.mock.calls.length;
    expect(await (await prompt(service, "w1:p9")).json()).toEqual({ provider: "codex", url: null, user_code: null, wants_code: false, ended: true });
    expect(read.mock.calls.length).toBe(before);
  });

  it("reads no pane it did not launch, and none for a device that only watches", async () => {
    const service = await launched();
    expect((await prompt(service, "w1:p1")).status).toBe(404);
    expect((await prompt(service, "w1:p9", true)).status).toBe(403);
  });

  it("types a pasted code into the login's own pane, then Enter, and nothing else", async () => {
    const service = await launched("claude");
    screen = readFileSync(join(import.meta.dir, "fixtures/usage-login/claude.recent_unwrapped.txt"), "utf8");
    expect((await code(service, { pane: "w1:p9", code: "  abc123#state-xyz \n" })).status).toBe(204);
    expect(typed).toEqual([{ pane: "w1:p9", text: "abc123#state-xyz" }]);
    expect(keys).toEqual([{ pane: "w1:p9", keys: ["Enter"] }]);
  });

  it("refuses a code with a control character, a code for a pane it did not launch, and one the CLI did not ask for", async () => {
    const service = await launched("claude");
    screen = readFileSync(join(import.meta.dir, "fixtures/usage-login/claude.recent_unwrapped.txt"), "utf8");
    expect((await code(service, { pane: "w1:p9", code: "abc\u0003rm -rf ~\r" })).status).toBe(400);
    expect((await code(service, { pane: "w1:p1", code: "abc" })).status).toBe(404);
    screen = "bash-5.3$ ";
    expect((await code(service, { pane: "w1:p9", code: "abc" })).status).toBe(409);
    expect(typed).toEqual([]);
  });
});
