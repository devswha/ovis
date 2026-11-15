import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsProvider } from "../lib/settings.ts";
import { translate } from "../lib/i18n.ts";
import { createShellTestPage } from "../lib/relay/shellTestPage.fixture.ts";
import { EnrollmentStatus } from "./EnrollmentStatus.tsx";

it("reports account enrollment without promising access for every account device", () => {
  const browser = createShellTestPage();
  try {
    const markup = renderToStaticMarkup(<SettingsProvider><EnrollmentStatus state="complete" /></SettingsProvider>);
    expect(markup).toContain("In your account");
    expect(markup).not.toContain("Every device");
  } finally { browser.dispose(); }
});

it.each(["en", "ko", "ja", "zh"] as const)("renders only confirmed admission counts in %s", (language) => {
  const browser = createShellTestPage();
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: [language] } });
    for (const admitted of [0, 1, 2]) {
      const markup = renderToStaticMarkup(<SettingsProvider><EnrollmentStatus state={{ state: "complete", admitted }} /></SettingsProvider>);
      expect(markup).toContain(translate(language, "In your account"));
      expect(markup).toContain(translate(language, "Devices added: {count}", { count: admitted }));
    }
  } finally { browser.dispose(); }
});

it.each(["en", "ko", "ja", "zh"] as const)("says in %s that the enrollment waits for the account service, with the seconds it asked for", (language) => {
  const browser = createShellTestPage();
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: [language] } });
    const markup = renderToStaticMarkup(<SettingsProvider><EnrollmentStatus state={{ state: "waiting", seconds: 42 }} /></SettingsProvider>);
    expect(markup).toContain('role="status" data-enrollment-wait="42"');
    expect(/<p class="relay-shell-detail">([^<]*)<\/p>/.exec(markup)?.[1]).toContain("42");
  } finally { browser.dispose(); }
});
