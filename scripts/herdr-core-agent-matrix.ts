/**
 * The herdr-core column of the agent table, from runs (todo 67): for each agent, through an Ovis server
 * under test, whether the chat shows the conversation live and after a reload, whether a permission
 * and a question card show and their buttons reach the agent, whether the status goes working ->
 * waiting -> done, whether the inbox's waiting rule (a blocked pane) fills, whether an alert fires, and
 * whether a composer message reaches the agent exactly once. Every cell is what was measured, or
 * NOT RUN with the reason.
 *
 *   OVIS_MATRIX_TOKEN=<test token> bun scripts/herdr-core-agent-matrix.ts --url http://127.0.0.1:17671 \
 *     --scratch <folder on its machine> --out matrix.md [--agents silent,claude,codex] [--evidence <dir>]
 *
 * By default only `silent` runs: the stand-in that reports nothing (a plain shell drawing a menu-like
 * text), which must show no status and no card. A real agent (`claude`, `codex`) runs only when
 * `--agents` names it and the run has a token (`--token-file`, or OVIS_MATRIX_TOKEN; never on the
 * command line, where the process list shows it): it signs in with the account of the machine it runs
 * on and spends it, and the script says so before it starts one. Codex's read-only sandbox mounts a
 * fresh /dev, so its scratch folder must not be under /dev/shm.
 *
 * The server is any Ovis that reaches the core under test: one of its own on an isolated core, or a
 * controller's fleet forward to a machine (the same routes under /api/machines/<id>/ with --machine).
 * The agents start the way the product starts them (POST /api/workspace/create with agent.kind).
 * Chat messages go as the composer sends them (WebSocket `submit`), card answers through
 * POST /api/pane/prompt/answer. Alerts are heard through Settings -> Alerts -> Also send to (a json
 * webhook to a receiver of this script), which gets the same alert decisions as a push device
 * (server/push.ts `webhook`). The server's own destination cannot be read back (its URL and token are
 * never answered), so a server that has one is refused unless `--skip-alerts`, which leaves it alone and
 * marks the alert cells NOT RUN; the script's own is removed again on every exit, an error or an
 * interrupt included, as is every workspace it started. Never point this at someone's live session.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { authenticatedWebSocket } from "../server/remote-websocket.ts";

type Json = Record<string, unknown>;
type Row = Record<"chat_live" | "history" | "permission_card" | "question_card" | "status" | "inbox" | "notification" | "send_once", string>;
const CELLS: (keyof Row)[] = ["chat_live", "history", "permission_card", "question_card", "status", "inbox", "notification", "send_once"];
const NOT_RUN = (why: string) => `NOT RUN: ${why}`;
/** how long an interrupted run waits for its call in flight: each call gives up after 30 s */
const IN_FLIGHT_MS = 35_000;
const notRun = (why: string): Row & { notes: string[] } => Object.assign(Object.fromEntries(CELLS.map((key) => [key, NOT_RUN(why)])) as Row, { notes: [] });

/** One agent's run: how it is started, what makes it ask, and how its start-up screens are passed. */
interface Plan {
  kind: string;
  /** arguments that make it ask before writing a file, whatever its saved defaults say */
  args: string[];
  /** a start-up card's option to press (folder trust, update menu), by its label */
  startOption: RegExp;
  question: string;
  exit: string;
}
const PERMISSION_TASK = "Create a file named hello.txt in this folder containing the single word hi, then reply with the word FINISHED.";
const PLANS: Record<string, Plan> = {
  claude: { kind: "claude", args: ["--permission-mode", "default"], startOption: /trust this folder/i, exit: "/exit",
    question: "Use your AskUserQuestion tool to ask me one question: which color, with the options red and blue. Then reply with only the color I chose." },
  codex: { kind: "codex", args: ["--sandbox", "read-only", "--ask-for-approval", "on-request"], startOption: /^(?:skip|trust and continue)$/i, exit: "/exit",
    question: "Use your request_user_input tool to ask me one question: which color, with the options red and blue. Then reply with only the color I chose." },
};

export interface MatrixOptions {
  base: string;
  token: string;
  machine?: string;
  scratch: string;
  out: string;
  evidence: string;
  agents: string[];
  hookHost: string;
  skipAlerts: boolean;
}

/** The run's options from its arguments and environment, or why it must not run. */
export function matrixOptions(argv: string[], env: Record<string, string | undefined>): MatrixOptions | { refused: string } {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: {
      url: { type: "string" }, "token-file": { type: "string" }, machine: { type: "string" },
      scratch: { type: "string" }, out: { type: "string" }, evidence: { type: "string" },
      agents: { type: "string", default: "silent" }, "hook-host": { type: "string", default: "127.0.0.1" },
      "skip-alerts": { type: "boolean", default: false },
    } }).values;
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
  const base = parsed.url?.replace(/\/$/, "");
  if (!base || !parsed.scratch || !parsed.out) return { refused: "usage: --url <server> --scratch <folder on its machine> --out <file.md> [--token-file <file>] [--agents silent,claude,codex] [--skip-alerts]" };
  let token = env["OVIS_MATRIX_TOKEN"] ?? "";
  if (parsed["token-file"]) {
    try { token = readFileSync(parsed["token-file"], "utf8").trim(); } catch { return { refused: `the token file ${parsed["token-file"]} cannot be read` }; }
  }
  const agents = parsed.agents.split(",").map((name) => name.trim()).filter(Boolean);
  const real = agents.filter((agent) => PLANS[agent]);
  if (real.length > 0 && token === "") return { refused: `a real agent (${real.join(", ")}) runs only with the server's address and a token (--token-file or OVIS_MATRIX_TOKEN)` };
  if (real.includes("codex") && resolve(parsed.scratch).startsWith("/dev/shm/")) return { refused: "Codex's read-only sandbox mounts a fresh /dev: a scratch folder under /dev/shm is not there for it" };
  return {
    base, token, ...(parsed.machine ? { machine: parsed.machine } : {}), scratch: parsed.scratch, out: parsed.out,
    evidence: parsed.evidence ?? `${parsed.out}.runs`, agents, hookHost: parsed["hook-host"], skipAlerts: parsed["skip-alerts"],
  };
}

/**
 * Runs the matrix and writes its table. Everything it changed on the server (its own alert destination, the
 * workspaces it started) is undone in `cleanup`, which runs once on every exit: the end, an error, or an
 * interrupt (`interrupted` resolves when the process is told to stop).
 */
export async function runMatrix(options: MatrixOptions, say: (line: string) => void = console.log, interrupted?: Promise<void>): Promise<number> {
  const { base, token, machine } = options;
  const prefix = machine ? `/api/machines/${encodeURIComponent(machine)}` : "/api";
  mkdirSync(options.evidence, { recursive: true });
  const log = (agent: string, entry: unknown) => appendFileSync(join(options.evidence, `${agent}.jsonl`), JSON.stringify({ at: Date.now(), entry }) + "\n");
  async function call(path: string, body?: unknown, method?: string): Promise<{ status: number; body: Json }> {
    const response = await fetch(base + prefix + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    try { return { status: response.status, body: JSON.parse(text) as Json }; } catch { return { status: response.status, body: { text } }; }
  }

  // what this run changed, undone once by cleanup
  const started = new Set<string>();
  let hookSet = false;
  let socket: WebSocket | null = null;
  let receiver: ReturnType<typeof Bun.serve> | null = null;
  let cleaned: Promise<void> | null = null;
  const cleanup = (): Promise<void> => cleaned ??= (async () => {
    for (const workspace of started) await call("/workspace/close", { workspace_id: workspace }).catch(() => undefined);
    started.clear();
    if (hookSet) {
      const removed = await call("/alerts/webhook", undefined, "DELETE").catch(() => null);
      if (removed?.status !== 204) say(`the alert destination this run set could not be removed (${removed?.status ?? "no answer"}): remove it in Settings -> Alerts`);
      hookSet = false;
    }
    socket?.close();
    receiver?.stop(true);
  })();
  const stop = interrupted?.then(async () => { await cleanup(); return "interrupted" as const; });

  const run = async (): Promise<number> => {
    const view = await call("/alerts/webhook");
    if (view.status !== 200) { say(`the server did not answer its alert settings (${view.status}): is the address and token right?`); return 2; }
    if (view.body["configured"] === true && !options.skipAlerts) {
      say("the server already has an alert destination (Settings -> Alerts -> Also send to), which this script cannot read back to restore: rerun with --skip-alerts, which leaves it alone and marks the alert cells NOT RUN");
      return 2;
    }

    const waiters = new Set<{ check: () => boolean; resolve: () => void }>();
    const events: { at: number; message: Json }[] = [];
    const alerts: { at: number; body: Json }[] = [];
    const wake = () => { for (const waiter of [...waiters]) if (waiter.check()) { waiters.delete(waiter); waiter.resolve(); } };
    const until = (label: string, check: () => boolean, ms: number): Promise<boolean> => {
      if (check()) return Promise.resolve(true);
      const { promise, resolve: done } = Promise.withResolvers<boolean>();
      const waiter = { check, resolve: () => { clearTimeout(timer); done(true); } };
      const timer = setTimeout(() => { waiters.delete(waiter); say(`no ${label} within ${ms} ms`); done(false); }, ms);
      waiters.add(waiter);
      return promise;
    };

    socket = authenticatedWebSocket(base.replace(/^http/, "ws") + (machine ? `${prefix}/ws` : "/ws"), token);
    {
      const { promise, resolve: opened, reject } = Promise.withResolvers<void>();
      socket.onopen = () => opened();
      socket.onerror = () => reject(new Error("the server's socket did not open"));
      await promise;
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Json;
      if (message["type"] !== "snapshot") events.push({ at: Date.now(), message });
      wake();
    };
    const send = (message: Json) => socket!.send(JSON.stringify(message));

    let alertsOn = false;
    let alertsWhy = "--skip-alerts: the server's own alert destination was left alone";
    if (!options.skipAlerts) {
      receiver = Bun.serve({
        hostname: options.hookHost, port: 0,
        fetch: async (request) => { alerts.push({ at: Date.now(), body: await request.json() as Json }); wake(); return new Response("ok"); },
      });
      const hook = await call("/alerts/webhook", { preset: "json", url: `http://${options.hookHost}:${receiver.port}/hook`, alerts: { input: true, done: "always" } }, "PUT");
      hookSet = hook.status === 200;
      // answered after an interrupt's cleanup ran: removed now, as cleanup would have
      if (hookSet && cleaned !== null) { await call("/alerts/webhook", undefined, "DELETE").catch(() => undefined); hookSet = false; }
      alertsOn = hookSet;
      alertsWhy = `the alert destination could not be set (${hook.status})`;
    }

    const statusesOf = (pane: string, since: number) => events.filter((event) => event.at >= since && event.message["type"] === "pane-status" && event.message["pane_id"] === pane).map((event) => String(event.message["agent_status"]));
    const alertsOf = (pane: string, since: number) => alerts.filter((alert) => alert.at >= since && alert.body["pane_id"] === pane);
    const prompt = async (pane: string) => (await call(`/pane/prompt?pane_id=${pane}`)).body["prompt"] as Json | null;
    const conversation = async (pane: string) => (await call(`/pane/conversation?pane_id=${pane}`)).body;
    const userTurns = (conv: Json, text: string) => ((conv["turns"] as Json[] | undefined) ?? []).filter((turn) => turn["role"] === "user" && JSON.stringify(turn["parts"]).includes(text.slice(0, 40))).length;
    const promptSeen = (pane: string, since: number) => () => events.some((event) => event.at >= since && event.message["type"] === "prompt-changed" && event.message["pane_id"] === pane);
    const statusSeen = (pane: string, since: number, status: string) => () => statusesOf(pane, since).includes(status);
    /** a workspace this run made, closed by cleanup if the run does not close it itself */
    const create = async (body: Json) => {
      const created = await call("/workspace/create", body);
      const workspace = created.body["workspace_id"];
      if (typeof workspace !== "string") return created;
      // answered after an interrupt's cleanup ran: closed now, and the run goes no further
      if (cleaned !== null) { await call("/workspace/close", { workspace_id: workspace }).catch(() => undefined); throw new Error("interrupted"); }
      started.add(workspace);
      return created;
    };
    const close = async (workspace: string) => { await call("/workspace/close", { workspace_id: workspace }); started.delete(workspace); };

    /** A card of `kind` on the pane, waited for on its prompt-changed events, read from GET /api/pane/prompt. */
    async function cardOf(pane: string, kind: RegExp, ms: number): Promise<Json | null> {
      const deadline = Date.now() + ms;
      let since = Date.now();
      for (;;) {
        const shown = await prompt(pane);
        if (shown && kind.test(String(shown["kind"]))) return shown;
        if (Date.now() > deadline) return null;
        await until(`a prompt change on ${pane}`, promptSeen(pane, since), deadline - Date.now());
        since = Date.now();
      }
    }

    async function submit(pane: string, text: string, id: number): Promise<boolean> {
      send({ type: "submit", id, pane_id: pane, text, payload: text });
      await until(`submit-result ${id}`, () => events.some((event) => event.message["type"] === "submit-result" && event.message["id"] === id), 30_000);
      return events.some((event) => event.message["type"] === "submit-result" && event.message["id"] === id && event.message["ok"] === true);
    }

    async function runAgent(agent: string, plan: Plan, id: number): Promise<Row & { notes: string[] }> {
      const notes: string[] = [];
      const cwd = join(options.scratch, `matrix-${agent}-${Date.now()}`);
      // the folder is on the server's machine: made here only when that is this PC
      if (!machine) mkdirSync(cwd, { recursive: true });
      say(`starting a real ${agent} on ${base}${machine ? ` (machine ${machine})` : ""}: it signs in with that machine's account and spends it`);
      const created = await create({ cwd, label: `matrix-${agent}`, agent: { kind: plan.kind, args: plan.args } });
      log(agent, { created });
      const pane = created.body["pane_id"];
      if (created.status !== 200 || typeof pane !== "string") throw new Error(`${agent} did not start: ${JSON.stringify(created.body)}`);
      const workspace = String(created.body["workspace_id"]);
      send({ type: "conversation-watch", pane_id: pane, enabled: true, detached: true });
      send({ type: "prompt-watch", pane_id: pane, enabled: true });
      // a start-up card (folder trust, update menu), or the agent at rest (no card for 20 s)
      for (let round = 0; round < 3; round++) {
        const card = await cardOf(pane, /menu|approval/, 20_000);
        if (card === null) break;
        const shown = (card["options"] as { label: string }[]) ?? [];
        const index = shown.findIndex((option) => plan.startOption.test(option.label));
        log(agent, { startCard: card });
        notes.push(`start-up card ${card["title"]}: ${index < 0 ? "no option to press" : shown[index]!.label}`);
        if (index < 0) break;
        await call("/pane/prompt/answer", { pane_id: pane, prompt_id: card["id"], option_index: index });
      }

      const t1 = Date.now();
      const sent1 = await submit(pane, PERMISSION_TASK, id);
      const permission = await cardOf(pane, /approval/, 120_000);
      const liveDuring = permission ? await conversation(pane) : null;
      const chatLive = liveDuring !== null && liveDuring["source"] !== "scrollback" && userTurns(liveDuring, PERMISSION_TASK) > 0;
      const blockedOnPermission = await until("blocked on permission", statusSeen(pane, t1, "blocked"), 15_000);
      const waitingAlert = alertsOn && blockedOnPermission ? await until("a waiting alert", () => alertsOf(pane, t1).some((alert) => alert.body["kind"] === "permission"), 30_000) : false;
      let permissionReached = false;
      if (permission) {
        const answered = await call("/pane/prompt/answer", { pane_id: pane, prompt_id: permission["id"], option_index: 0 });
        permissionReached = answered.status === 200 && await until("done after the permission", statusSeen(pane, t1, "done"), 120_000);
      }
      // whether the approved command took effect is told by the file, seen only where the script runs
      const written = machine ? "not checked on another machine" : await Bun.file(join(cwd, "hello.txt")).exists() ? "hello.txt was written" : "hello.txt was not written";
      const doneAlert = alertsOn && permissionReached ? await until("a done alert", () => alertsOf(pane, t1).some((alert) => alert.body["kind"] === "done"), 30_000) : false;
      const history = await conversation(pane);
      log(agent, { permission, liveDuring, history: history["source"], statuses: statusesOf(pane, t1), alerts: alertsOf(pane, t1), written });

      const t2 = Date.now();
      const sent2 = await submit(pane, plan.question, id + 1);
      const question = await cardOf(pane, /question/, 120_000);
      const blockedOnQuestion = question ? await until("blocked on the question", statusSeen(pane, t2, "blocked"), 8_000) : false;
      let questionReached = false;
      if (question) {
        await call("/pane/prompt/answer", { pane_id: pane, prompt_id: question["id"], option_index: 1 });
        questionReached = await until("done after the question", statusSeen(pane, t2, "done"), 120_000);
      }
      const final = await conversation(pane);
      const answeredBlue = JSON.stringify(final["turns"] ?? []).toLowerCase().includes("blue");
      log(agent, { question, statuses: statusesOf(pane, t2), final });

      await submit(pane, plan.exit, id + 2);
      await until(`${agent} gone from the pane`, () => events.some((event) => event.at >= t2 && event.message["type"] === "pane-status" && event.message["pane_id"] === pane && event.message["agent_status"] === "unknown"), 10_000);
      await close(workspace);

      const once1 = userTurns(final, PERMISSION_TASK);
      const once2 = userTurns(final, plan.question);
      return {
        notes,
        chat_live: chatLive ? "yes: the conversation was shown while it waited on its permission" : `no: while it waited the chat was \`${liveDuring?.["source"] ?? "not read"}\``,
        history: history["source"] !== "scrollback" && userTurns(history, PERMISSION_TASK) > 0 ? "yes" : `no (\`${history["source"]}\`)`,
        permission_card: permission ? `yes, ${permissionReached ? "the answer reached it" : "but the turn did not finish after the answer"}; ${written}` : "no card",
        question_card: question ? `yes${questionReached && answeredBlue ? ", the answer reached it" : ", the answer was not seen"}` : "no card",
        status: `${[...new Set(statusesOf(pane, t1))].join(" -> ")}; on its question: ${blockedOnQuestion ? "blocked" : `not blocked (${[...new Set(statusesOf(pane, t2))].join(" -> ")})`}`,
        inbox: `permission: ${blockedOnPermission ? "fills" : "empty"}; question: ${blockedOnQuestion ? "fills" : "empty"}`,
        notification: alertsOn ? `waiting: ${waitingAlert ? "yes" : "no"}; done: ${doneAlert ? "yes" : "no"} (through Also send to)` : NOT_RUN(alertsWhy),
        send_once: sent1 && sent2 ? `${once1 === 1 && once2 === 1 ? "yes" : "no"} (${once1} and ${once2} user turns)` : "no: a submit was refused",
      };
    }

    /** The stand-in that reports nothing: no status, no card, may be shown. */
    async function runSilent(): Promise<Row & { notes: string[] }> {
      const created = await create({ cwd: options.scratch, label: "matrix-silent" });
      if (created.status !== 200 || typeof created.body["pane_id"] !== "string") throw new Error(`the stand-in did not start: ${JSON.stringify(created.body)}`);
      const pane = created.body["pane_id"];
      const t = Date.now();
      await call("/pane/input", { pane_id: pane, text: "printf 'Do you want to proceed?\\n 1. Yes\\n 2. No\\n'; cat" });
      await call("/pane/keys", { pane_id: pane, keys: ["enter"] });
      const onScreen = async () => JSON.stringify((await call(`/pane/read?pane_id=${pane}&source=visible&format=text`)).body).includes("2. No");
      const deadline = t + 10_000;
      while (!(await onScreen()) && Date.now() < deadline) await Bun.sleep(100);
      const session = (await call("/session")).body["snapshot"] as { panes: Json[] } | undefined;
      if (!session) throw new Error("the server answered no snapshot");
      const shown = session.panes.find((entry) => entry["pane_id"] === pane) ?? {};
      const card = await prompt(pane);
      const conv = await conversation(pane);
      log("silent", { shown, card, conv: conv["source"] });
      await call("/pane/keys", { pane_id: pane, keys: ["ctrl+c"] });
      await close(String(created.body["workspace_id"]));
      const none = (shown["agent_status"] === "unknown" || shown["agent_status"] === undefined) && card === null;
      return {
        notes: [`agent ${String(shown["agent"])}, status ${String(shown["agent_status"])}, card ${card ? "shown" : "none"}`],
        chat_live: `\`${conv["source"]}\` (terminal text)`, history: "-", permission_card: card ? "INVENTED" : "none (right)",
        question_card: "-", status: none ? "none (right: nothing reported, no rule matched)" : "INVENTED", inbox: none ? "empty (right)" : "INVENTED",
        notification: "-", send_once: "-",
      };
    }

    const rows: [string, Row & { notes: string[] }][] = [];
    let id = 1000;
    for (const agent of options.agents) {
      // interrupted: no further agent is started
      if (cleaned !== null) break;
      try {
        if (agent === "silent") rows.push([agent, await runSilent()]);
        else if (PLANS[agent]) rows.push([agent, await runAgent(agent, PLANS[agent]!, id += 10)]);
        else rows.push([agent, notRun("no run plan for this agent in the script yet")]);
      } catch (error) {
        rows.push([agent, notRun(error instanceof Error ? error.message : String(error))]);
      }
    }

    const columns: [keyof Row, string][] = [["chat_live", "Chat, live"], ["history", "Chat after reload"], ["permission_card", "Permission card"], ["question_card", "Question card"], ["status", "Status"], ["inbox", "Needs you"], ["notification", "Alert"], ["send_once", "Composer message once"]];
    const table = [
      `Measured ${new Date().toISOString()} through ${base}${machine ? ` (machine ${machine})` : ""}.`,
      "",
      `| Agent | ${columns.map(([, name]) => name).join(" | ")} |`,
      `| --- | ${columns.map(() => "---").join(" | ")} |`,
      ...rows.map(([agent, row]) => `| ${agent} | ${columns.map(([key]) => row[key].replaceAll("|", "\\|")).join(" | ")} |`),
      "",
      ...rows.flatMap(([agent, row]) => row.notes.map((note) => `- ${agent}: ${note}`)),
      "",
    ].join("\n");
    if (cleaned !== null) return 130;
    writeFileSync(options.out, table);
    say(table);
    return 0;
  };

  const running = run();
  try {
    const result = await (stop ? Promise.race([running, stop]) : running);
    if (result !== "interrupted") return result;
    // a call still in flight may yet answer with something it made (a workspace created on the server): the run's own
    // guards close it once that answer comes, so it settles before the process may end, within the calls' own bound
    say("interrupted: closing what the call in flight makes before exiting");
    let bound: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([running.catch(() => undefined), new Promise<void>((settle) => { bound = setTimeout(settle, IN_FLIGHT_MS); })]);
    clearTimeout(bound);
    return 130;
  } finally {
    await cleanup();
  }
}

if (import.meta.main) {
  const options = matrixOptions(process.argv.slice(2), process.env);
  if ("refused" in options) {
    console.error(options.refused);
    process.exit(2);
  }
  const { promise: interrupted, resolve: interrupt } = Promise.withResolvers<void>();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  process.exit(await runMatrix(options, console.log, interrupted));
}
