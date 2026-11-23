/**
 * omp's plan files, named the one way the bridge and the chat both read them. omp keeps a session's
 * plan in `local://<slug>-plan.md` (the slug: letters, numbers, `_` and `-`), or in `local://PLAN.md`
 * until the agent proposes one under a slug of its own. `local://` is a folder next to the session's
 * transcript; server/omp-plan.ts resolves it, for that session alone.
 */

/** the plan file omp starts plan mode with, before any slug is proposed */
export const OMP_PLAN_PLACEHOLDER = "local://PLAN.md";

const LOCAL_PLAN = /^local:\/\/(?:([A-Za-z0-9_-]{1,100})-plan|PLAN)\.md$/;

/**
 * The file a `local://` plan path names, and the slug it is under (null for `PLAN.md`); null for any other
 * path: another file, a folder, a range after the name (`:14-22`), a path that climbs.
 */
export function ompPlanName(path: unknown): { file: string; slug: string | null } | null {
  if (typeof path !== "string") return null;
  const match = LOCAL_PLAN.exec(path);
  return match === null ? null : { file: path.slice("local://".length), slug: match[1] ?? null };
}

/** The plan an omp `edit` script edits: the path in the header of its first section, `[local://x-plan.md#F920]`. */
export function ompPlanEditTarget(script: string): string | null {
  const header = /^\[([^\]#\n]+)(?:#[0-9A-Za-z]+)?\]/.exec(script);
  return header !== null && ompPlanName(header[1]) !== null ? header[1]! : null;
}

/**
 * What a plan notice in the chat says happened, as its `source` carries it: omp's plan mode came on, a
 * plan was proposed for review, plan mode was paused or turned off, or a plan was approved. The slug the
 * plan is under follows a colon, when the record names one (`plan-ready:omp-proto-readme`).
 */
export type PlanNoticeKind = "on" | "ready" | "paused" | "off" | "approved";

export function planNoticeSource(kind: PlanNoticeKind, slug: string | null): string {
  return slug === null ? `plan-${kind}` : `plan-${kind}:${slug}`;
}

export function planNoticeOf(source: string | undefined): { kind: PlanNoticeKind; slug: string | null } | null {
  const match = source === undefined ? null : /^plan-(on|ready|paused|off|approved)(?::([A-Za-z0-9_-]+))?$/.exec(source);
  return match === null ? null : { kind: match[1] as PlanNoticeKind, slug: match[2] ?? null };
}
