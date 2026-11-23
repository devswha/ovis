/**
 * GET /api/pane/omo-tasks: an OmO pane's background tasks and workflows, or a Claude Code, OpenCode or omp pane's
 * subagents, read through the trackers the server core owns. The dispatcher in index.ts runs the access gate first.
 */
import { type ClaudeSubagentStatus, within } from "./claude-subagents.ts";
import { scanClaudeTasks } from "./claude-task-scan.ts";
import { paneGet } from "./herdr/client.ts";
import { badRequest, jsonResponse, setRequestRoute } from "./http.ts";
import { processAlive, type OmoStatus } from "./omo-status.ts";
import { omoRuns, omoTasks } from "./omo-tasks.ts";
import type { OmpSubagentStatus } from "./omp-subagents.ts";
import type { OpencodeSubagentStatus } from "./opencode-subagents.ts";

export type TaskTrackers = {
  omo: Pick<OmoStatus, "sessionOf"> & Partial<Pick<OmoStatus, "jobsOf">>;
  claudeAgents: Pick<ClaudeSubagentStatus, "sessionOf" | "ensure">;
  opencodeAgents: Pick<OpencodeSubagentStatus, "sessionOf" | "ensure" | "tasksOf" | "beginRead">;
  /** a caller that wires none lists no omp subagents */
  ompAgents?: Pick<OmpSubagentStatus, "sessionOf" | "ensure" | "tasksOf">;
};

export async function handleTasksRequest(request: Request, url: URL, pathname: string, { omo, claudeAgents, opencodeAgents, ompAgents }: TaskTrackers): Promise<Response | null> {
  if (pathname === "/api/pane/omo-tasks") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const paneId = url.searchParams.get("pane_id");
    if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
    const server_time = new Date().toISOString();
    // Its transcript is found here if the background lookup has not got to it yet, and no tracker holds the pane as it runs now:
    // a session kept of what the pane ran before (not live) says nothing of what it runs now
    // (for a second at most: a slow herdr answers with what is known, and the next ask has the rest)
    if (omo.sessionOf(paneId) === null && claudeAgents.sessionOf(paneId)?.live !== true && opencodeAgents.sessionOf(paneId)?.live !== true && (ompAgents?.sessionOf(paneId) ?? null) === null) {
      await within(1000, (async () => {
        const begun = opencodeAgents.beginRead();
        const pane = await paneGet(paneId);
        opencodeAgents.ensure(pane, begun);
        await claudeAgents.ensure(pane);
        await ompAgents?.ensure(pane, true);
      })());
    }
    for (let tries = 0; tries < 3; tries++) {
      // the tracker holds a pane only while it runs omp, whatever else it ran before
      if (ompAgents !== undefined && ompAgents.sessionOf(paneId) !== null) return jsonResponse({ tasks: ompAgents.tasksOf(paneId), runs: [], server_time });
      const session = omo.sessionOf(paneId);
      if (session !== null) {
        const tasks = [...omoTasks(session.cwd, session.sessionId, processAlive), ...(omo.jobsOf?.(paneId) ?? [])];
        const running = tasks.filter((task) => task.status === "running");
        return jsonResponse({ tasks: [...running, ...tasks.filter((task) => task.status !== "running")], runs: omoRuns(session.cwd, session.sessionId), server_time });
      }
      // an OpenCode pane's subagents are its child sessions; of a pane that ran both, the one it runs now
      const opencode = opencodeAgents.sessionOf(paneId);
      if (opencode === null || (!opencode.live && claudeAgents.sessionOf(paneId)?.live === true)) {
        const claude = claudeAgents.sessionOf(paneId);
        if (claude === null) return jsonResponse({ tasks: [], runs: [], server_time });
        const tasks = await scanClaudeTasks(claude, request.signal);
        const current = claudeAgents.sessionOf(paneId);
        const codeNow = opencodeAgents.sessionOf(paneId);
        const same = current !== null && current.path === claude.path && current.live === claude.live
          && current.startedAt === claude.startedAt && current.read === claude.read;
        if (same && omo.sessionOf(paneId) === null && (ompAgents?.sessionOf(paneId) ?? null) === null && (codeNow === null || (!codeNow.live && current.live))) {
          return jsonResponse({ tasks, runs: [], server_time });
        }
        continue;
      }
      const read = await opencodeAgents.tasksOf(paneId);
      const bound = read?.read ?? opencode;
      const current = opencodeAgents.sessionOf(paneId);
      const same = current !== null && current.path === bound.path && current.session === bound.session && current.live === bound.live;
      if (same && omo.sessionOf(paneId) === null && (ompAgents?.sessionOf(paneId) ?? null) === null && (current.live || claudeAgents.sessionOf(paneId)?.live !== true)) {
        return jsonResponse({ tasks: read?.tasks ?? [], runs: [], server_time, ...(read !== null && read.unlisted > 0 ? { more_running: read.unlisted } : {}) });
      }
    }
    return jsonResponse({ tasks: [], runs: [], server_time });
  }
  return null;
}
