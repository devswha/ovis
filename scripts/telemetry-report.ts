/**
 * The telemetry counts of telemetry/README.md ("Reading the counts") as one markdown report, plus
 * daily active installs per country for the last 28 days, and the last 7 finished days' button counts
 * (the counts table): for each counter and width, the share of installs that used it and the median
 * range among those that did, never a mean, beside the share that were shown the control at all.
 *
 *   bun scripts/telemetry-report.ts --out <file.md> [--html <file.html>]
 *
 * Runs \`bunx wrangler d1 execute herdr-web-ui-telemetry --remote --json\` from telemetry/, so it
 * needs \`bunx wrangler login\` once with the account that owns the database. It only reads.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const COUNTS_INSTALLS = "Installs that sent button counts, per width, the last 7 finished days";
export const COUNTS_BUCKETS = "Button counts per width: installs that used each, and days per range, the last 7 finished days";
export const COUNTS_SHOWN = "Controls shown, per width: installs that saw each at least once, the last 7 finished days";
export const SWITCHES_BY_AGENT = "Chat/terminal switches by kind of agent and width: installs running it that switched on its panes, the last 7 finished days";
export const SWITCH_DAYS_BY_VERSION = "Install-days with a chat/terminal switch, per version, the last 7 finished days";
export const COUNTER_SHARES = "Button counts per width: share of installs that used each, and the median range of a day it was used";

export const QUERIES: ReadonlyArray<{ title: string; sql: string }> = [
  { title: "New installs per week", sql: "SELECT strftime('%Y-%W', day) AS week, COUNT(*) FROM events WHERE event = 'install' GROUP BY week ORDER BY week;" },
  { title: "Daily active installs (DAU)", sql: "SELECT day, COUNT(*) FROM active GROUP BY day ORDER BY day;" },
  { title: "Weekly active installs (WAU), the last 7 days", sql: "SELECT COUNT(DISTINCT install_id) FROM active WHERE day >= date('now', '-6 days');" },
  { title: "Monthly active installs (MAU), the last 30 days", sql: "SELECT COUNT(DISTINCT install_id) FROM active WHERE day >= date('now', '-29 days');" },
  { title: "Installs running each kind of agent, the last 30 days", sql: "SELECT harness.value AS harness, COUNT(DISTINCT active.install_id) AS installs FROM active CROSS JOIN json_each(active.harnesses) AS harness WHERE active.day >= date('now', '-29 days') GROUP BY harness.value ORDER BY installs DESC, harness;" },
  { title: "Installs per kind of screen, the last 30 days", sql: "SELECT surface.value AS surface, COUNT(DISTINCT active.install_id) AS installs FROM active CROSS JOIN json_each(active.usage, '$.surfaces') AS surface WHERE active.day >= date('now', '-29 days') AND active.usage IS NOT NULL GROUP BY surface.value ORDER BY installs DESC, surface;" },
  { title: "Installs per way in, the last 30 days", sql: "SELECT way.value AS ingress, COUNT(DISTINCT active.install_id) AS installs FROM active CROSS JOIN json_each(active.usage, '$.ingress') AS way WHERE active.day >= date('now', '-29 days') AND active.usage IS NOT NULL GROUP BY way.value ORDER BY installs DESC, ingress;" },
  { title: "Prompt answers and pane alerts per day", sql: "SELECT day, COUNT(*) AS installs, SUM(json_extract(usage, '$.prompt_answers')) AS prompt_answers, SUM(json_extract(usage, '$.alerts_delivered')) AS alerts_delivered, SUM(json_extract(usage, '$.alerts_opened')) AS alerts_opened FROM active WHERE usage IS NOT NULL GROUP BY day ORDER BY day;" },
  { title: "Installs per country (last country seen)", sql: "SELECT country, COUNT(*) FROM (SELECT (SELECT country FROM events WHERE install_id = e.install_id AND country IS NOT NULL ORDER BY rowid DESC LIMIT 1) AS country FROM events e GROUP BY install_id) GROUP BY country ORDER BY 2 DESC;" },
  { title: "Daily active installs per country, the last 28 days", sql: "SELECT day, country, COUNT(*) FROM active WHERE day >= date('now', '-27 days') GROUP BY day, country ORDER BY day, country;" },
  { title: COUNTS_INSTALLS, sql: "SELECT w.width, COUNT(DISTINCT c.install_id) AS installs FROM (SELECT 'narrow' AS width UNION ALL SELECT 'wide') AS w JOIN counts c ON (CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END) IS NOT NULL WHERE c.day >= date('now', '-7 days') AND c.day < date('now') GROUP BY w.width ORDER BY w.width;" },
  { title: COUNTS_BUCKETS, sql: "SELECT w.width, item.key AS counter, COUNT(DISTINCT c.install_id) AS installs, SUM(item.value = 1) AS days_1_2, SUM(item.value = 2) AS days_3_9, SUM(item.value = 3) AS days_10_29, SUM(item.value = 4) AS days_30_up FROM (SELECT 'narrow' AS width UNION ALL SELECT 'wide') AS w JOIN counts c ON (CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END) IS NOT NULL CROSS JOIN json_each(CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END, '$.counts') AS item WHERE c.day >= date('now', '-7 days') AND c.day < date('now') GROUP BY w.width, item.key ORDER BY w.width, installs DESC, item.key;" },
  { title: COUNTS_SHOWN, sql: "SELECT w.width, item.value AS control, COUNT(DISTINCT c.install_id) AS installs FROM (SELECT 'narrow' AS width UNION ALL SELECT 'wide') AS w JOIN counts c ON (CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END) IS NOT NULL CROSS JOIN json_each(CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END, '$.shown') AS item WHERE c.day >= date('now', '-7 days') AND c.day < date('now') GROUP BY w.width, item.value ORDER BY w.width, installs DESC, item.value;" },
  { title: SWITCHES_BY_AGENT, sql: "SELECT w.width, h.value AS agent, COUNT(DISTINCT c.install_id) AS running, COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM json_each(CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END, '$.counts') AS x WHERE x.key IN ('view_chat_' || h.value, 'view_terminal_' || h.value)) THEN c.install_id END) AS switched FROM (SELECT 'narrow' AS width UNION ALL SELECT 'wide') AS w JOIN counts c ON (CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END) IS NOT NULL JOIN active a ON a.day = c.day AND a.install_id = c.install_id CROSS JOIN json_each(a.harnesses) AS h WHERE c.day >= date('now', '-7 days') AND c.day < date('now') GROUP BY w.width, h.value ORDER BY w.width, running DESC, h.value;" },
  { title: SWITCH_DAYS_BY_VERSION, sql: "SELECT c.version, COUNT(*) AS days, SUM(EXISTS (SELECT 1 FROM json_each(c.narrow, '$.counts') AS x WHERE x.key GLOB 'view_*_by_*') OR EXISTS (SELECT 1 FROM json_each(c.wide, '$.counts') AS x WHERE x.key GLOB 'view_*_by_*')) AS days_switched FROM counts c WHERE c.day >= date('now', '-7 days') AND c.day < date('now') GROUP BY c.version ORDER BY c.version;" },
];

/** A bucket's range, as the counts message names it (shared/telemetry.ts countBucket). */
export const BUCKET_RANGES = ["1-2", "3-9", "10-29", "30+"] as const;

/**
 * For each counter and width: the share of the installs that sent counts at that width which used it at
 * least once, and the median range of a day it was used. Means are left out: a few heavy installs would
 * carry them.
 */
export function counterShares(installs: ReadonlyArray<Record<string, unknown>>, buckets: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  const total = new Map(installs.map((row) => [String(row["width"]), Number(row["installs"])]));
  return buckets.map((row) => {
    const days = [row["days_1_2"], row["days_3_9"], row["days_10_29"], row["days_30_up"]].map(Number);
    const half = days.reduce((sum, count) => sum + count, 0) / 2;
    let seen = 0;
    const median = days.findIndex((count) => (seen += count) >= half);
    const of = total.get(String(row["width"])) ?? 0;
    return { width: row["width"], counter: row["counter"], installs: row["installs"], percent: of === 0 ? 0 : Math.round(1000 * Number(row["installs"]) / of) / 10, median_day: BUCKET_RANGES[median] ?? "-" };
  });
}

const escapeHtml = (value: unknown) => String(value ?? "NULL").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The report as one page: a table per section, a column named percent drawn as a bar too. */
export function html(title: string, sections: ReadonlyArray<{ title: string; rows: ReadonlyArray<Record<string, unknown>> }>): string {
  const body = sections.map(({ title: heading, rows }) => {
    if (!rows.length) return `<h2>${escapeHtml(heading)}</h2><p>(no rows)</p>`;
    const columns = Object.keys(rows[0]!);
    const cell = (column: string, value: unknown) => column === "percent"
      ? `<td class="num"><span class="bar" style="width:${Math.max(0, Math.min(100, Number(value)))}px"></span> ${escapeHtml(value)}%</td>`
      : `<td${typeof value === "number" ? ' class="num"' : ""}>${escapeHtml(value)}</td>`;
    return `<h2>${escapeHtml(heading)}</h2><table><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>${rows.map((row) => `<tr>${columns.map((column) => cell(column, row[column])).join("")}</tr>`).join("")}</table>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font:14px system-ui,sans-serif;margin:24px;color:#1d2330}table{border-collapse:collapse;margin-bottom:8px}td,th{padding:4px 10px;border-bottom:1px solid #e5e7eb;text-align:left}th{background:#f6f7f9}.num{text-align:right}.bar{display:inline-block;height:9px;background:#0ea5e9;border-radius:2px}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>\n`;
}

/** A markdown table of D1 result rows; a row's keys are the columns. */
export function table(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (!rows.length) return "(no rows)";
  const columns = Object.keys(rows[0]!);
  const cell = (value: unknown) => String(value ?? "NULL").replaceAll("|", "\\|");
  return [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${columns.map((column) => cell(row[column])).join(" | ")} |`)].join("\n");
}

async function d1(sql: string): Promise<Array<Record<string, unknown>> | null> {
  const child = Bun.spawn(["bunx", "wrangler", "d1", "execute", "herdr-web-ui-telemetry", "--remote", "--json", "--command", sql], { cwd: join(import.meta.dir, "..", "telemetry"), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) return null;
  try {
    const parsed = JSON.parse(out) as Array<{ success?: boolean; results?: Array<Record<string, unknown>> }>;
    const result = parsed[0];
    return result?.success === true ? result.results ?? null : null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  // a flag is followed by its file: a flag with none (or another flag in its place) is a usage error, not a silent skip
  const option = (name: string): string | undefined => {
    const at = process.argv.indexOf(name);
    if (at < 0) return undefined;
    const value = process.argv[at + 1];
    if (value === undefined || value.startsWith("--")) { console.error("Usage: bun scripts/telemetry-report.ts --out <file.md> [--html <file.html>]"); process.exit(1); }
    return value;
  };
  const out = option("--out");
  const page = option("--html");
  if (!out) {
    console.error("Usage: bun scripts/telemetry-report.ts --out <file.md> [--html <file.html>]");
    process.exit(1);
  }
  const results: Array<{ title: string; rows: Array<Record<string, unknown>> }> = [];
  for (const query of QUERIES) {
    const rows = await d1(query.sql);
    if (rows === null) {
      console.error(`telemetry report: "${query.title}" failed: run bunx wrangler login first (in telemetry/), with the account that owns herdr-web-ui-telemetry`);
      process.exit(1);
    }
    results.push({ title: query.title, rows });
  }
  const rowsOf = (title: string) => results.find((result) => result.title === title)?.rows ?? [];
  results.push({ title: COUNTER_SHARES, rows: counterShares(rowsOf(COUNTS_INSTALLS), rowsOf(COUNTS_BUCKETS)) });
  const heading = "Telemetry report";
  const note = `Run at ${new Date().toISOString()}. Counts are a trend, not an audit (telemetry/README.md).`;
  writeFileSync(out, [`# ${heading}\n\n${note}`, ...results.map(({ title, rows }) => `## ${title}\n\n${table(rows)}`)].join("\n\n") + "\n");
  if (page) writeFileSync(page, html(`${heading} · ${note}`, results));
  console.log(`telemetry report: ${results.length} tables written to ${out}${page ? ` and ${page}` : ""}`);
}
