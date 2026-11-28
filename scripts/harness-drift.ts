/**
 * Which agent CLIs run without Ovis's own link because their latest release is outside the versions it was measured
 * on: an approval hook's (each adapter's `supports`, server/approvals/adapters.ts) or Codex's own server's
 * (supportsCodexServer). Outside them Ovis adds nothing and falls back to reading the agent's terminal without a word
 * (and pi, which asks nothing itself, runs commands without the approval dialog the hook adds), so a new release
 * (Codex 0.172) turns cards and turn ends back into screen reading on the day it ships. Prime Agent's link is its daemon's
 * protocol, which its ACP child and its pane's chat depend on (server/prime.ts, server/agent-tools/harnesses.ts).
 *
 *   bun scripts/harness-drift.ts
 *
 * Reads each CLI's latest version from the npm registry (Prime Agent's from its GitHub releases), nothing else, and prints a Markdown table of every CLI whose
 * latest release Ovis does not read as data, or whose version could not be read. Exits 1 when the table has a row.
 */
import { APPROVAL_ADAPTERS } from "../server/approvals/adapters.ts";
import { supportsCodexServer } from "../server/approvals/codex.ts";
import { parseVersion } from "../shared/agent-catalog.ts";

export interface Harness {
  /** the agent kind, as herdr names it */
  readonly kind: string;
  /** Ovis's link to it, which a release outside the window runs without */
  readonly link: string;
  /** where its releases are published: an npm package, or `github:<owner>/<repo>` for one released only on GitHub */
  readonly npm: string;
  readonly supports: (version: string) => boolean;
}

/** The npm package each agent's official install puts in place (claude.ai, pi.dev, get.omo.dev and omp.sh install these too). */
export const RELEASES: Readonly<Record<string, string>> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  copilot: "@github/copilot",
  cmd: "command-code",
  omo: "omo-ai",
  omp: "@oh-my-pi/pi-coding-agent",
  pi: "@earendil-works/pi-coding-agent",
};

function releasesOf(kind: string): string {
  const npm = RELEASES[kind];
  if (npm === undefined) throw new Error(`scripts/harness-drift.ts: no npm package for ${kind}; add it to RELEASES`);
  return npm;
}

export const HARNESSES: readonly Harness[] = [
  ...APPROVAL_ADAPTERS.map((adapter) => ({ kind: adapter.kind, link: "Ovis's hook", npm: releasesOf(adapter.kind), supports: (version: string) => adapter.supports(version) })),
  { kind: "codex", link: "its own server", npm: releasesOf("codex"), supports: supportsCodexServer },
  // measured on 0.10.5: its ACP child's own daemon (--daemon-socket, a shutdown scoped to it), and the daemon's `list` and
  // direct worker link that prove which session a pane's chat shows; a release past 0.10 may change any of them
  { kind: "prime-agent", link: "its daemon's protocol", npm: "github:PrimeIntellect-ai/prime-agent", supports: (version) => version.startsWith("0.10.") },
];

/** A CLI's latest release, or why it could not be read. */
export type Latest = { readonly version: string } | { readonly error: string };

export interface Drift {
  readonly kind: string;
  readonly npm: string;
  readonly link: string;
  /** the latest version, or why none was read */
  readonly latest: string;
  readonly outside: boolean;
}

/** The CLIs whose latest release Ovis does not read as data (`outside`), and those whose release was not read, in HARNESSES' order. */
export function drifted(harnesses: readonly Harness[], latest: ReadonlyMap<string, Latest>): Drift[] {
  return harnesses.flatMap((harness): Drift[] => {
    const release = latest.get(harness.kind) ?? { error: "not asked" };
    if ("error" in release) return [{ kind: harness.kind, npm: harness.npm, link: harness.link, latest: release.error, outside: false }];
    return harness.supports(release.version) ? [] : [{ kind: harness.kind, npm: harness.npm, link: harness.link, latest: release.version, outside: true }];
  });
}

export function driftTable(rows: readonly Drift[]): string {
  if (rows.length === 0) return "Every agent CLI's latest release is one Ovis reads as data.";
  return [
    "| Agent CLI | Released as | Latest | Now |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.kind} | \`${row.npm}\` | ${row.outside ? row.latest : "unknown"} | ${row.outside ? `runs without ${row.link}: outside the measured versions` : `not checked: ${row.latest}`} |`),
  ].join("\n");
}

export async function latestOf(npm: string): Promise<Latest> {
  const github = npm.startsWith("github:") ? npm.slice("github:".length) : null;
  const source = github === null ? "npm" : "GitHub";
  try {
    const response = await fetch(github === null ? `https://registry.npmjs.org/${npm}/latest` : `https://api.github.com/repos/${github}/releases/latest`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { error: `${source} answered ${response.status}` };
    const answer = await response.json() as { version?: unknown; tag_name?: unknown };
    const version = github === null ? answer.version : answer.tag_name;
    // as the server reads an agent's --version: its first dotted number, a pre-release suffix left out
    const numeric = typeof version === "string" ? parseVersion(version) : null;
    return numeric === null ? { error: `${source} named no version (${JSON.stringify(version)})` } : { version: numeric };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

if (import.meta.main) {
  const latest = new Map(await Promise.all(HARNESSES.map(async (harness) => [harness.kind, await latestOf(harness.npm)] as const)));
  const rows = drifted(HARNESSES, latest);
  console.log(driftTable(rows));
  process.exitCode = rows.length === 0 ? 0 : 1;
}
