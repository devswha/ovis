import { describe, expect, it } from "bun:test";
import { translate } from "../lib/i18n.ts";
import { relayFailureText } from "./relayFailureText.ts";

describe.each(["en", "ko", "ja", "zh"] as const)("a PC that could not be opened (%s)", (language) => {
  const t = (key: string, vars?: Record<string, string | number>) => translate(language, key, vars);
  it("calls a PC the relay had nobody for Machine offline, and a relay or a PC that did not answer this device Could not reach this machine", () => {
    const said = (["pc-offline", "pc-unresponsive", "relay-unreachable"] as const).map((failure) => {
      const text = relayFailureText(t, failure, "pc-a");
      return [text.title, text.retry];
    });
    expect(said).toEqual([[t("Machine offline"), true], [t("Could not reach this machine"), true], [t("Could not reach this machine"), true]]);
  });

  it("names the PC in what to do next where the PC is the cause", () => {
    expect((["pc-offline", "pc-unresponsive"] as const).map((failure) => relayFailureText(t, failure, "pc-a").copy.includes("pc-a"))).toEqual([true, true]);
  });
});
