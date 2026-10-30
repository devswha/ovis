import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loginPrompt } from "./usage-login-prompt.ts";

/** What `pane.read` (recent_unwrapped) answered for the real CLIs, recorded in a throwaway HOME before any approval. */
const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures/usage-login", `${name}.recent_unwrapped.txt`), "utf8");

describe("loginPrompt", () => {
  it("reads Codex's device page and one-time code (codex-cli 0.163.0)", () => {
    expect(loginPrompt("codex", fixture("codex-device"))).toEqual({ url: "https://auth.openai.com/codex/device", user_code: "PDLB-SLDUA", wants_code: false });
  });

  it("reads Claude Code's whole sign-in address, unwrapped, and its paste-code prompt (2.1.312)", () => {
    const prompt = loginPrompt("claude", fixture("claude"));
    expect(prompt.url).toStartWith("https://claude.com/cai/oauth/authorize?code=true&client_id=");
    expect(prompt.url).toEndWith("&state=I_rJvwisf9zPQQG8yG7ndiPCIFFobJS-i0l3JWeSQ1g");
    expect(prompt.user_code).toBeNull();
    expect(prompt.wants_code).toBe(true);
  });

  it("says nothing before the CLI has printed its address", () => {
    expect(loginPrompt("claude", "bash-5.3$ claude auth login\nOpening browser to sign in…\n")).toEqual({ url: null, user_code: null, wants_code: false });
    expect(loginPrompt("codex", "Welcome to Codex [v0.163.0]\n")).toEqual({ url: null, user_code: null, wants_code: false });
  });

  it("offers no address outside the provider's own sign-in hosts, nor a plain http one", () => {
    expect(loginPrompt("claude", "If the browser didn't open, visit: https://claude.com.evil.example/cai/oauth/authorize?x=1\nPaste code here if prompted > ").url).toBeNull();
    expect(loginPrompt("codex", "1. Open this link\n   http://auth.openai.com/codex/device\n2. Enter this one-time code\n   ABCD-12345\n").url).toBeNull();
  });

  it("takes the latest address and code when a login printed more than once", () => {
    const twice = `${fixture("codex-device")}\n${fixture("codex-device").replace("PDLB-SLDUA", "ZZZZ-11111")}`;
    expect(loginPrompt("codex", twice).user_code).toBe("ZZZZ-11111");
  });
});
