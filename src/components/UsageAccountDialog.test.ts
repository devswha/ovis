import { expect, it } from "bun:test";
import { externalUsageSignInHint } from "./UsageAccountDialog.tsx";

it("gives each external provider its own sign-in guidance", () => {
  const english = (key: string) => key;
  expect(externalUsageSignInHint("gemini", english)).toBe("Sign in through Gemini CLI on the server PC.");
  expect(externalUsageSignInHint("antigravity", english)).toBe("Sign in from the Antigravity app on the server PC.");
});
