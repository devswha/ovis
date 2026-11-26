import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const LINUX_CHROME = "/opt/google/chrome/chrome";

/**
 * The longest TMPDIR Chromium starts with on Linux: it binds `<TMPDIR>/org.chromium.Chromium.XXXXXX/SingletonSocket`
 * (46 characters past TMPDIR), and a socket path holds at most 107. One character longer, the launch aborts or hangs.
 */
export const MAX_CHROME_TMPDIR = 61;

/** Throws when `tmpdir` is too long for Chromium's socket on Linux, naming the TMPDIR to use instead. */
export function checkChromeTmpdir(tmpdir: string = process.env["TMPDIR"] || "/tmp", platform: NodeJS.Platform = process.platform): void {
  if (platform !== "linux" || tmpdir.length <= MAX_CHROME_TMPDIR) return;
  throw new Error(`TMPDIR is ${tmpdir.length} characters (${tmpdir}); Chromium cannot start with more than ${MAX_CHROME_TMPDIR} on Linux. Run browser scripts with a shorter one, such as TMPDIR=/var/tmp/ovis-ui.`);
}

/**
 * The browser a script launches: `CHROME_PATH` when it is set (the browser lane sets it), Google
 * Chrome's Linux package where it is installed, and otherwise the lockfile's Playwright Chromium,
 * which is what a Mac or a Windows PC has (`bun node_modules/playwright-core/cli.js install chromium`).
 * Throws first when TMPDIR is too long for the browser to start (checkChromeTmpdir).
 */
export function chromePath(): string {
  checkChromeTmpdir();
  return process.env["CHROME_PATH"] || (existsSync(LINUX_CHROME) ? LINUX_CHROME : chromium.executablePath());
}
