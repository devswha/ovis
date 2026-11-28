/**
 * Isolated multi-viewport and multi-theme browser probe for independent UI verification (`.claude/skills/verify-ui/SKILL.md`).
 *
 *   bun scripts/verify-ui.ts [--evidence <dir>] [--label <name>] [--path <suffix>] [--matrix <ids>] [--json]
 *   bun scripts/verify-ui.ts --url <http://127.0.0.1:PORT/app/> [--evidence <dir>] [--label <name>]
 *
 * Without `--url`, builds and serves the disposable demo app over loopback (`prefix: "/"`) via `withDemoBrowser`
 * (`scripts/demo-browser.ts`). With `--url`, opens an already-running loopback or own-tailnet preview, refusing
 * wildcard/LAN binds (`0.0.0.0`, `[::]`, `192.168.x.x`) and external hosts.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrowserContext, BrowserContextOptions } from "playwright-core";
import { bindScope } from "../server/access.ts";
import { LIVE_HERDR, changedFiles, findBrowserChecks } from "./browser-checks.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { withLiveBrowser } from "./verify-ui-live.ts";

export interface VerifyMatrixCell {
  readonly id: "desktop-dark" | "desktop-light" | "phone-dark" | "phone-light";
  readonly viewport: { readonly width: number; readonly height: number };
  readonly colorScheme: "dark" | "light";
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
}

export const VERIFY_MATRIX: readonly VerifyMatrixCell[] = [
  { id: "desktop-dark", viewport: { width: 1280, height: 800 }, colorScheme: "dark", isMobile: false, hasTouch: false },
  { id: "desktop-light", viewport: { width: 1280, height: 800 }, colorScheme: "light", isMobile: false, hasTouch: false },
  { id: "phone-dark", viewport: { width: 390, height: 844 }, colorScheme: "dark", isMobile: true, hasTouch: true },
  { id: "phone-light", viewport: { width: 390, height: 844 }, colorScheme: "light", isMobile: true, hasTouch: true },
];

export interface CellProbeReport {
  readonly id: VerifyMatrixCell["id"];
  readonly url: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly expectedTheme: "dark" | "light";
  readonly resolvedTheme: string | null;
  readonly mountedShell: boolean;
  readonly crashed: boolean;
  readonly horizontalOverflowPx: number;
  readonly pageErrors: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly serverErrors: readonly string[];
  readonly screenshot: string | null;
  readonly ok: boolean;
  readonly failures: readonly string[];
}

export interface VerifyUiReport {
  readonly label: string;
  readonly target: "demo" | "url";
  readonly baseUrl: string;
  readonly matchedScripts: readonly string[];
  readonly cells: readonly CellProbeReport[];
  readonly ok: boolean;
}

let cachedTailnetSuffix: string | null | undefined;

function ownTailnetSuffix(): string | null {
  if (cachedTailnetSuffix !== undefined) return cachedTailnetSuffix;
  try {
    const out = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 2_000 });
    if (out.status === 0 && out.stdout) {
      const parsed = JSON.parse(out.stdout) as { MagicDNSSuffix?: unknown };
      const raw = typeof parsed.MagicDNSSuffix === "string" ? parsed.MagicDNSSuffix.trim().toLowerCase().replace(/^\.+|\.+$/g, "") : "";
      cachedTailnetSuffix = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/.test(raw) ? raw : null;
      return cachedTailnetSuffix;
    }
  } catch {}
  cachedTailnetSuffix = null;
  return null;
}

/**
 * Validates that a preview URL stays on loopback or within this PC's tailnet (`bindScope` in `server/access.ts`,
 * or this machine's own MagicDNS `.ts.net` suffix), never a wildcard/LAN bind, credentialed URL, or external origin.
 */
export function assertSafeVerifyUrl(raw: string, options: { readonly tailnetSuffix?: string | null } = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Verify URL must use http: or https:, got ${parsed.protocol}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("Refusing URL with embedded credentials.");
  }
  const host = parsed.hostname.toLowerCase();
  const scope = bindScope(host);
  if (scope === "loopback" || scope === "tailnet") return parsed;

  const suffix = options.tailnetSuffix !== undefined ? options.tailnetSuffix : ownTailnetSuffix();
  if (suffix !== null && (host === suffix || host.endsWith(`.${suffix}`))) return parsed;

  if (host === "0.0.0.0" || host === "[::]" || host === "::" || host.startsWith("[::ffff:0:")) {
    throw new Error(`Refusing wildcard host ${parsed.hostname} (AGENTS.md: bind 127.0.0.1 for tests or the Tailscale IP for previews, never 0.0.0.0).`);
  }
  throw new Error(`Refusing non-local/non-tailnet host ${parsed.hostname}; pass a loopback (127.0.0.1) or own-tailnet URL.`);
}

/**
 * Resolves `--path` against `baseUrl` while forbidding scheme prefixes, backslashes, protocol-relative URLs and
 * cross-origin escapes.
 */
export function resolveTargetUrl(baseUrl: string, suffix: string, options: { readonly tailnetSuffix?: string | null } = {}): string {
  const base = assertSafeVerifyUrl(baseUrl, options);
  if (!suffix) return base.toString();
  if (suffix.includes("\\")) throw new Error("--path must not contain backslashes");
  if (suffix.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(suffix)) {
    throw new Error(`--path must be a relative path, query or hash on ${base.origin}, got "${suffix}"`);
  }
  if (suffix.startsWith("#")) {
    const next = new URL(base.toString());
    next.hash = suffix;
    return next.toString();
  }
  if (suffix.startsWith("?")) {
    const next = new URL(base.toString());
    next.search = suffix;
    return next.toString();
  }
  const withSlash = new URL(base.toString());
  if (!withSlash.pathname.endsWith("/")) withSlash.pathname = `${withSlash.pathname}/`;
  const resolved = new URL(suffix.replace(/^\/+/, ""), withSlash);
  assertSafeVerifyUrl(resolved.toString(), options);
  if (resolved.origin !== base.origin) {
    throw new Error(`--path escaped origin ${base.origin}: ${resolved.origin}`);
  }
  return resolved.toString();
}

/**
 * Strips live `HERDR_*` / `HC_*` session variables so QA commands never attach to or mutate the user's running
 * session, and validates `HOST` through `bindScope` (`server/access.ts`).
 */
export function sanitizedVerifyEnv(
  source: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !LIVE_HERDR.includes(key)) {
      env[key] = value;
    }
  }
  Object.assign(env, overrides);
  const host = env["HOST"]?.trim();
  if (host && bindScope(host) === "other") {
    throw new Error(`Refusing HOST=${host} (AGENTS.md: bind 127.0.0.1 or the Tailscale IP, never 0.0.0.0 or LAN).`);
  }
  return env;
}

/** Applies `sanitizedVerifyEnv` directly to `target` (such as `process.env`) and returns a restore callback. */
export function applySanitizedVerifyEnv(target: Record<string, string | undefined> = process.env): () => void {
  sanitizedVerifyEnv(target);
  const saved: Array<readonly [string, string]> = [];
  for (const key of LIVE_HERDR) {
    const prev = target[key];
    if (prev !== undefined) {
      saved.push([key, prev]);
      delete target[key];
    }
  }
  return () => {
    for (const [key, value] of saved) target[key] = value;
  };
}

export function selectMatrixCells(raw: string | undefined): readonly VerifyMatrixCell[] {
  if (raw === undefined || raw.trim() === "") return VERIFY_MATRIX;
  const wanted = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  const selected = wanted.map((id) => {
    const found = VERIFY_MATRIX.find((cell) => cell.id === id);
    if (!found) {
      throw new Error(`Unknown matrix cell "${id}". Valid cells: ${VERIFY_MATRIX.map((cell) => cell.id).join(", ")}`);
    }
    return found;
  });
  if (selected.length === 0) throw new Error("--matrix requires at least one cell id");
  return selected;
}

function safeLabel(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) throw new Error(`Invalid --label "${raw}"`);
  return cleaned;
}

const firstLine = (error: unknown): string => (error instanceof Error ? error.message.split("\n")[0]! : String(error));

function requireFlagValue(flag: string, next: string | undefined): string {
  if (!next || next.startsWith("-")) throw new Error(`${flag} requires a value`);
  return next;
}

async function probeCells(
  openContext: (overrides?: BrowserContextOptions) => Promise<BrowserContext>,
  baseUrl: string,
  options: { readonly cells: readonly VerifyMatrixCell[]; readonly pathSuffix: string; readonly evidenceDir: string | null; readonly label: string },
): Promise<CellProbeReport[]> {
  const origin = new URL(baseUrl).origin;
  const targetUrl = resolveTargetUrl(baseUrl, options.pathSuffix);
  const reports: CellProbeReport[] = [];
  if (options.evidenceDir !== null) mkdirSync(options.evidenceDir, { recursive: true });

  for (const cell of options.cells) {
    const failures: string[] = [];
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const serverErrors: string[] = [];
    let metrics = { resolvedTheme: null as string | null, crashed: false, mountedShell: false, horizontalOverflowPx: 0 };
    let screenshot: string | null = null;
    let context: BrowserContext | undefined;
    try {
      context = await openContext({
        viewport: cell.viewport,
        colorScheme: cell.colorScheme,
        isMobile: cell.isMobile,
        hasTouch: cell.hasTouch,
        storageState: {
          cookies: [],
          origins: [{
            origin,
            localStorage: [{ name: "ovis:settings", value: JSON.stringify({ theme: cell.colorScheme }) }],
          }],
        },
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => { pageErrors.push(error.message); });
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("response", (response) => {
        try {
          if (new URL(response.url()).origin === origin && response.status() >= 500) {
            serverErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
          }
        } catch {}
      });

      try {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        // index.html starts with `<div id="root"><div class="boot" role="status">…</div></div>`;
        // wait until React replaces `.boot` with the mounted application shell.
        await page.waitForFunction(() => {
          const root = document.getElementById("root");
          return root !== null && root.childElementCount > 0 && root.querySelector(":scope > .boot") === null;
        }, undefined, { timeout: 20_000 });
      } catch (error) {
        // A page that never loads or never mounts is this cell's failure: keep probing the rest.
        failures.push(`load: ${firstLine(error)}`);
      }

      try {
        metrics = await page.evaluate(() => {
          const root = document.getElementById("root");
          const doc = document.documentElement;
          return {
            resolvedTheme: doc.dataset["theme"] ?? null,
            crashed: root !== null && root.querySelector(".app-crash") !== null,
            mountedShell: root !== null && root.childElementCount > 0 && root.querySelector(":scope > .boot") === null && root.querySelector(".app-crash") === null,
            horizontalOverflowPx: Math.max(0, Math.round(doc.scrollWidth - window.innerWidth)),
          };
        });
        if (options.evidenceDir !== null) {
          const path = join(options.evidenceDir, `${options.label}-${cell.id}.png`);
          await page.screenshot({ path, timeout: 10_000 });
          screenshot = path;
        }
      } catch (error) {
        // A failed navigation leaves no page to measure or capture.
        failures.push(`probe: ${firstLine(error)}`);
      }
    } catch (error) {
      // The browser itself failed (a context or page that would not open): the cell still gets its row.
      failures.push(`browser: ${firstLine(error)}`);
    } finally {
      await context?.close().catch((error: unknown) => { failures.push(`close: ${firstLine(error)}`); });
    }

    if (metrics.crashed) failures.push("#root rendered .app-crash");
    if (!metrics.mountedShell) failures.push("#root did not finish mounting past .boot");
    if (metrics.resolvedTheme !== cell.colorScheme) {
      failures.push(`expected data-theme="${cell.colorScheme}", got "${metrics.resolvedTheme ?? "null"}"`);
    }
    if (metrics.horizontalOverflowPx > 1) {
      failures.push(`document horizontal overflow of ${metrics.horizontalOverflowPx}px at ${cell.viewport.width}px width`);
    }
    for (const err of pageErrors) failures.push(`pageerror: ${err}`);
    for (const err of consoleErrors) failures.push(`console.error: ${err}`);
    for (const err of serverErrors) failures.push(`5xx response: ${err}`);

    reports.push({
      id: cell.id,
      url: targetUrl,
      viewport: cell.viewport,
      expectedTheme: cell.colorScheme,
      resolvedTheme: metrics.resolvedTheme,
      mountedShell: metrics.mountedShell,
      crashed: metrics.crashed,
      horizontalOverflowPx: metrics.horizontalOverflowPx,
      pageErrors,
      consoleErrors,
      serverErrors,
      screenshot,
      ok: failures.length === 0,
      failures,
    });
  }
  return reports;
}

const USAGE = `Usage:
  bun scripts/verify-ui.ts [--url <url>] [--path <suffix>] [--matrix <cells>] [--evidence <dir>] [--label <name>] [--json]

Options:
  --url <url>        Probe an existing loopback or own-tailnet preview URL instead of building the disposable demo app
  --path <suffix>    Append a relative path, ?query or #hash on the same origin
  --matrix <cells>   Comma-separated subset of: desktop-dark, desktop-light, phone-dark, phone-light
  --evidence <dir>   Save <label>-<cell>.png screenshots and <label>-report.json (defaults to UI_EVIDENCE_DIR)
  --label <name>     Artifact filename prefix, e.g. "before" or "after" (default: "probe")
  --json             Print the structured VerifyUiReport JSON`;

export interface VerifyCliOptions {
  readonly url: string | null;
  readonly pathSuffix: string;
  readonly cells: readonly VerifyMatrixCell[];
  readonly evidenceDir: string | null;
  readonly label: string;
  readonly json: boolean;
}

export function parseVerifyArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  urlOptions: { readonly tailnetSuffix?: string | null } = {},
): VerifyCliOptions {
  let url: string | null = null;
  let pathSuffix = "";
  let matrixRaw: string | undefined;
  let evidenceRaw = env["UI_EVIDENCE_DIR"]?.trim() || null;
  let label = "probe";
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--url") {
      const next = requireFlagValue("--url", argv[++i]);
      url = assertSafeVerifyUrl(next, urlOptions).toString();
      continue;
    }
    if (arg === "--path") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--path requires a value");
      pathSuffix = next;
      continue;
    }
    if (arg === "--matrix") {
      matrixRaw = requireFlagValue("--matrix", argv[++i]);
      continue;
    }
    if (arg === "--evidence") {
      evidenceRaw = requireFlagValue("--evidence", argv[++i]);
      continue;
    }
    if (arg === "--label") {
      label = safeLabel(requireFlagValue("--label", argv[++i]));
      continue;
    }
    throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
  }

  if (url !== null && pathSuffix !== "") resolveTargetUrl(url, pathSuffix, urlOptions);

  return {
    url,
    pathSuffix,
    cells: selectMatrixCells(matrixRaw),
    evidenceDir: evidenceRaw === null ? null : resolve(evidenceRaw),
    label,
    json,
  };
}

export async function runVerifyCli(argv: readonly string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const restoreEnv = applySanitizedVerifyEnv(process.env);
  try {
    const options = parseVerifyArgs(argv, process.env);
    const changed = changedFiles();
    const matchedScripts = changed.length > 0 ? findBrowserChecks(changed, { limit: 0 }).matches.map((match) => match.script) : [];

    let baseUrl = options.url ?? "";
    const cells = options.url !== null
      ? await withLiveBrowser(async ({ newContext }) => probeCells(newContext, options.url!, options))
      : await withDemoBrowser({ tempPrefix: "ovis-verify-ui-", prefix: "/" }, async ({ newContext, baseUrl: demoUrl }) => {
        baseUrl = demoUrl;
        return probeCells(newContext, demoUrl, options);
      });

    const report: VerifyUiReport = {
      label: options.label,
      target: options.url !== null ? "url" : "demo",
      baseUrl,
      matchedScripts,
      cells,
      ok: cells.every((cell) => cell.ok),
    };

    if (options.evidenceDir !== null) {
      writeFileSync(join(options.evidenceDir, `${options.label}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Target: ${report.target} (${report.baseUrl})`);
      if (report.matchedScripts.length > 0) {
        console.log(`Matched CI browser scripts (${report.matchedScripts.length}): ${report.matchedScripts.slice(0, 8).join(", ")}${report.matchedScripts.length > 8 ? ` (+${report.matchedScripts.length - 8} more)` : ""}`);
      }
      for (const cell of report.cells) {
        const status = cell.ok ? "PASS" : "FAIL";
        const shot = cell.screenshot ? ` -> ${cell.screenshot}` : "";
        console.log(`  [${status}] ${cell.id.padEnd(14)} ${cell.viewport.width}x${cell.viewport.height} theme=${cell.resolvedTheme ?? "null"} overflow=${cell.horizontalOverflowPx}px${shot}`);
        for (const failure of cell.failures) console.log(`         - ${failure}`);
      }
    }

    return report.ok ? 0 : 1;
  } finally {
    restoreEnv();
  }
}

if (import.meta.main) {
  try {
    process.exit(await runVerifyCli(process.argv.slice(2)));
  } catch (error) {
    console.error(`verify-ui: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
