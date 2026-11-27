/**
 * Browser setups a script makes by itself, each held to its count by scripts/conventions.test.ts (the counts may only shrink):
 *
 * - Direct contexts: `browser.newContext(…)` and `launchPersistentContext(…)`, counted in scripts/direct-contexts.json.
 *   Such a context has whatever the script thought of: one with the app's service worker and one without, one in the
 *   machine's language and one in English. `newContext(overrides)` of withDemoBrowser's session and
 *   `appContext(browser, overrides)` (scripts/app-context.ts) start every script from the same context instead.
 * - Demo launches: `chromium.launch(…)` in a script that builds the demo app itself, counted in
 *   scripts/demo-launches.json. withDemoBrowser (scripts/demo-browser.ts) builds, serves and launches the same way for all.
 *
 * `bun scripts/direct-contexts.ts` prints the current counts of direct contexts, `--launches` those of demo launches.
 */
import { files, lineOf, read, stripComments } from "./source-scan.ts";

const CONTEXT = /\.\s*(?:newContext|launchPersistentContext)\s*\(/g;
const LAUNCH = /\bchromium\s*\.\s*launch\w*\s*\(/g;
const BUILDS_DEMO = /\bbuild(?:Development)?DemoApp\s*\(/;
/** The factory and the harness make the one call of each kind the scripts share; the rest only name the calls. */
const SHARED = ["scripts/app-context.ts", "scripts/demo-browser.ts", "scripts/demo-build.ts", "scripts/direct-contexts.ts", "scripts/conventions.test.ts"];

export const browserScriptFiles = (): string[] => files("scripts/**/*.{ts,tsx,mjs,js}").filter((file) => !SHARED.includes(file));

function found(file: string, text: string, call: RegExp): string[] {
  const code = stripComments(text, { strings: true });
  const lines = text.split("\n");
  return [...code.matchAll(call)].map((match) => {
    const line = lineOf(code, match.index);
    return `${file}:${line}: ${lines[line - 1]!.trim().slice(0, 160)}`;
  });
}

export const directContexts = (file: string, text = read(file)): string[] => found(file, text, CONTEXT);

export const demoLaunches = (file: string, text = read(file)): string[] =>
  BUILDS_DEMO.test(stripComments(text, { strings: true })) ? found(file, text, LAUNCH) : [];

function countsOf(find: (file: string) => string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of browserScriptFiles()) {
    const count = find(file).length;
    if (count) counts[file] = count;
  }
  return counts;
}

export const directContextCounts = (): Record<string, number> => countsOf(directContexts);

export const demoLaunchCounts = (): Record<string, number> => countsOf(demoLaunches);

if (import.meta.main) console.log(JSON.stringify(process.argv.includes("--launches") ? demoLaunchCounts() : directContextCounts(), null, 2));
