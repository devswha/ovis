/**
 * `ovis start <machine> ... -- <command>` and `ovis wait <machine> <terminal> ...` (from source `bun scripts/plugin.ts
 * start|wait ...`; todo 32 of the relay-fleet plan): an orchestrating agent on the controller starts a program on a
 * named fleet machine with its first message, and waits for a terminal's shown state, through the machine's bridge
 * server (todo 27) behind the controller's loopback `bridge` forward (todo 25). `ovis start` with no arguments still
 * starts this PC's Ovis server (scripts/plugin.ts).
 *
 * Both name the machine as `ovis fleet` does, and read `GET /api/fleet/machines/<id>/bridge` (a process on the controller
 * with the server token in its Authorization header only): the forward's port and the bridge token, which goes into
 * one request header and is never printed, logged or put in an argument.
 *
 * - `start` posts `POST /api/workspace/create` with `program` and, with `--message`, `first_message` and
 *   `first_message_wait_ms`: the request stays open while the machine waits for the program's ready state, so it is
 *   the message's requester until the message settles (server/workspace-routes.ts). It prints one JSON line
 *   `{terminal, pane_id, first_message: {state, ready_by | code}}` and exits 0 when the message was sent (or none was
 *   asked for), 5 when it was held: it stays held in the pane's pending messages, never lost.
 * - `wait` follows the bridge's status stream (`/ws`: its snapshot, then each pane's status) and prints one JSON line
 *   `{state, derived, basis}` once the terminal's shown state is one of `--until`, exit 0; 124 when `--timeout`
 *   passes first; 3 when the terminal's program ends by itself first (the bridge's `pane-exited`). A terminal that is
 *   already finished is not in the snapshot: 82 `unknown_terminal`. Limit: one killed by someone (no `pane-exited`
 *   on herdr's rule) ends the wait only at `--timeout`.
 *
 * Their own failures exit with a code of ON_EXIT (80-86) and one line `ovis start: <why>` (or `ovis wait:`)
 * on stderr; with `--json` the record `{"error":{"origin","code","message","exit_code"[,"cause"]}}`.
 */
import { call, findMachine, FLEET_EXIT, Stop } from "./plugin-fleet.ts";
import type { FleetCommandIo, MachineRow } from "./plugin-fleet.ts";
import { fleetEnabled } from "../server/fleet/gate.ts";

/** The exit codes of `ovis start`'s and `ovis wait`'s own failures; any other code is the command's answer. */
export const ON_EXIT = {
  /** an answer this command cannot read */
  failed: 80,
  /** this command's own command line */
  usage: 81,
  /** no machine by that name, or a name more than one machine has */
  unknown: 82,
  /** the machine cannot be reached now: offline, not confirmed, removed, its runtime down; the cause is printed */
  unreachable: 83,
  /** the fleet is not on (`ovis fleet on`), or is held because the server has no OVIS_TOKEN */
  fleet_off: 84,
  /** no Ovis server answers at the address the `ovis` commands use */
  not_running: 85,
  /** the server refused: no token, a wrong one, or not a process on the controller */
  refused: 86,
} as const;

/** `ovis start`: the first message was held, not typed (it stays in the pane's pending messages). */
export const START_HELD_EXIT = 5;
/** `ovis wait`: the timeout passed before the terminal showed a state it waits for (the exit `timeout(1)` uses). */
export const WAIT_TIMEOUT_EXIT = 124;
/** `ovis wait`: the terminal's program ended by itself before it showed a state it waits for. */
export const WAIT_ENDED_EXIT = 3;
/** `ovis start --wait`: how long the first message may wait for the program's ready state, unless named. */
const DEFAULT_START_WAIT_S = 30;
const MAX_START_WAIT_S = 230;
const WAIT_STATES = ["idle", "blocked", "done", "working"] as const;
type WaitState = (typeof WAIT_STATES)[number];

export const START_HELP = `usage: ovis start [--json] <machine> [--agent <manifest id>] [--cwd <dir>] [--env K=V]... [--message <text>] [--wait <seconds>] -- <command> [args]
       ovis wait [--json] <machine> <terminal> --until idle,blocked,done[,working] [--timeout <seconds>]

  start: runs <command> on a fleet machine in a terminal of its own (under ovis-agent wrap with --agent) and prints
  {"terminal","pane_id","first_message":{"state","ready_by"|"code"}}. With --message the text is typed once the
  program says it is ready, within --wait seconds (${DEFAULT_START_WAIT_S}); exit 0 sent, 5 held (listed held on the pane).
  No bridge serves start yet: a request that gets that far answers 409 unsupported_runtime.
  wait: prints {"state","derived","basis"} once the terminal shows one of --until; exit 0, 124 on --timeout, 3 when
  the terminal's program ended by itself first (a terminal already gone: 82).
  Their own failures exit with: 81 usage, 82 unknown machine or terminal, 83 unreachable, 84 fleet off,
  85 server not running, 86 refused, 80 anything else.
`;

/** What `ovis start` and `ovis wait` need: the local server as `ovis fleet` reaches it, and a timer for `--timeout`. */
export interface StartIo extends Pick<FleetCommandIo, "origin" | "headers" | "stateDir"> {
  out(text: string): void;
  err(text: string): void;
  /** fires `fire` after `ms` (a test passes it at once); answers its cancel */
  readonly after?: (ms: number, fire: () => void) => () => void;
  /** `ovis wait`: told once the status stream's snapshot showed the terminal (a test acts only after it) */
  readonly following?: () => void;
}

type OwnExit = (typeof ON_EXIT)[keyof typeof ON_EXIT];

class StartStop extends Error {
  constructor(readonly exit: OwnExit, readonly code: string, message: string, readonly cause_?: string) { super(message); }
}

function fromFleet(stop: Stop): StartStop {
  const cause = typeof stop.details["cause"] === "string" ? stop.details["cause"] : undefined;
  if (stop.code === "machine_unreachable") return new StartStop(ON_EXIT.unreachable, stop.code, stop.message, cause);
  if (stop.code === "fleet_token_required") return new StartStop(ON_EXIT.fleet_off, stop.code, stop.message);
  const exit = ({
    [FLEET_EXIT.not_running]: ON_EXIT.not_running, [FLEET_EXIT.unknown]: ON_EXIT.unknown, [FLEET_EXIT.fleet_off]: ON_EXIT.fleet_off,
    [FLEET_EXIT.refused]: ON_EXIT.refused, [FLEET_EXIT.usage]: ON_EXIT.usage,
  } as Record<number, OwnExit>)[stop.exit] ?? ON_EXIT.failed;
  return new StartStop(exit, stop.code, stop.message);
}

const usage = (message: string) => new StartStop(ON_EXIT.usage, "usage", message);

/** The machine's bridge as this controller reaches it: its loopback forward and the token it asks for. */
interface Bridge { readonly name: string; readonly port: number; readonly token: string }

async function bridgeOf(io: StartIo, wanted: string): Promise<Bridge> {
  const asFleet = (error: unknown): never => { throw error instanceof Stop ? fromFleet(error) : error; };
  const listed = await call<{ machines: MachineRow[]; fleet_state?: string }>(io, "GET", "/api/fleet/machines").catch(asFleet);
  if (listed.fleet_state === "fleet_token_required") throw new StartStop(ON_EXIT.fleet_off, "fleet_token_required", "The fleet is held: this server has no OVIS_TOKEN.");
  let machine: MachineRow;
  try { machine = findMachine(listed.machines, wanted); }
  catch (error) {
    if (error instanceof Stop && error.code === "unknown_machine" && !fleetEnabled(io.stateDir)) throw new StartStop(ON_EXIT.fleet_off, "fleet_off", "The fleet is not on yet: run `ovis fleet on`, invite machines and confirm them first.");
    return asFleet(error);
  }
  const bridge = await call<{ port: number; token: string }>(io, "GET", `/api/fleet/machines/${machine.machine_id}/bridge`).catch((error: unknown) => {
    if (!(error instanceof Stop)) throw error;
    const stop = fromFleet(error);
    throw stop.exit === ON_EXIT.unreachable ? new StartStop(stop.exit, stop.code, `${machine.name || machine.machine_id} cannot be reached${stop.cause_ ? ` (${stop.cause_})` : ""}: ${stop.message}`, stop.cause_) : stop;
  });
  if (!Number.isInteger(bridge.port) || typeof bridge.token !== "string") throw new StartStop(ON_EXIT.failed, "bad_answer", "The server's answer about the machine's bridge cannot be read.");
  return { name: machine.name || machine.machine_id, port: bridge.port, token: bridge.token };
}

/** Splits `[--json] <own words> -- <rest>`; `values` names the options that take a value (repeatable ones collect). */
function split(args: readonly string[], values: readonly string[], needsRest: boolean) {
  const at = args.indexOf("--");
  if (needsRest && at < 0) throw usage("the command goes after --");
  const own = at < 0 ? [...args] : args.slice(0, at);
  const rest = at < 0 ? [] : args.slice(at + 1);
  const positional: string[] = [];
  const named = new Map<string, string[]>();
  let json = false;
  for (let index = 0; index < own.length; index++) {
    const arg = own[index]!;
    if (arg === "--json") { json = true; continue; }
    if (values.includes(arg)) {
      const value = own[++index];
      if (value === undefined) throw usage(`${arg} needs a value`);
      named.set(arg, [...named.get(arg) ?? [], value]);
      continue;
    }
    if (arg.startsWith("-")) throw usage(`unknown option ${arg}`);
    positional.push(arg);
  }
  return { json, positional, named, rest };
}

function seconds(text: string | undefined, fallback: number | undefined, max: number, flag: string): number | undefined {
  if (text === undefined) return fallback;
  if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0 || Number(text) > max) throw usage(`${flag} takes seconds, more than 0 and at most ${max}`);
  return Number(text);
}

function report(io: StartIo, origin: string, json: boolean, error: StartStop): number {
  if (json) io.err(JSON.stringify({ error: { origin, code: error.code, message: error.message, exit_code: error.exit, ...error.cause_ === undefined ? {} : { cause: error.cause_ } } }));
  else io.err(`${origin}: ${error.message}`);
  return error.exit;
}

/** One `ovis start <machine> ...` run; resolves with its exit code. */
export async function runStart(args: readonly string[], io: StartIo): Promise<number> {
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") { io.out(START_HELP); return 0; }
  let json = args.slice(0, Math.max(0, args.indexOf("--"))).includes("--json");
  try {
    const parsed = split(args, ["--agent", "--cwd", "--env", "--message", "--wait"], true);
    json = parsed.json;
    if (parsed.positional.length !== 1) throw usage("name one machine: ovis start <machine> [options] -- <command> [args]");
    if (parsed.rest.length === 0 || parsed.rest[0] === "") throw usage("the command goes after --");
    const one = (flag: string) => {
      const given = parsed.named.get(flag) ?? [];
      if (given.length > 1) throw usage(`${flag} may be given once`);
      return given[0];
    };
    const env: Record<string, string> = {};
    for (const pair of parsed.named.get("--env") ?? []) {
      const at = pair.indexOf("=");
      if (at <= 0) throw usage(`--env takes NAME=value, not ${pair}`);
      env[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const message = one("--message");
    const waitS = seconds(one("--wait"), message === undefined ? undefined : DEFAULT_START_WAIT_S, MAX_START_WAIT_S, "--wait");
    if (message === undefined && one("--wait") !== undefined) throw usage("--wait is how long --message may wait: give --message too");
    const agent = one("--agent");
    const cwd = one("--cwd");
    const bridge = await bridgeOf(io, parsed.positional[0]!);
    const body = {
      program: { argv: parsed.rest, ...(agent === undefined ? {} : { agent }) },
      ...(cwd === undefined ? {} : { cwd }), ...(Object.keys(env).length === 0 ? {} : { env }),
      ...(message === undefined ? {} : { first_message: message, first_message_wait_ms: Math.round(waitS! * 1000) }),
    };
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${bridge.port}/api/workspace/create`, {
        method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
      });
    } catch {
      throw new StartStop(ON_EXIT.unreachable, "bridge_unreachable", `${bridge.name}'s bridge did not answer through this controller.`);
    }
    const answer = await response.json().catch(() => null) as { error?: { code?: string; message?: string }; terminal?: string; pane_id?: string; first_message?: { state: string; ready_by?: string; code?: string } } | null;
    if (!response.ok || answer === null || typeof answer.terminal !== "string") {
      const code = typeof answer?.error?.code === "string" ? answer.error.code : `http_${response.status}`;
      const why = typeof answer?.error?.message === "string" ? answer.error.message : "its answer cannot be read";
      if (response.status === 401 || response.status === 403) throw new StartStop(ON_EXIT.refused, code, `${bridge.name}'s bridge refused: ${why}`);
      if (response.status === 400) throw new StartStop(ON_EXIT.usage, code, `${bridge.name}'s bridge refused the start: ${why}`);
      throw new StartStop(ON_EXIT.failed, code, `${bridge.name} did not start the program: ${why}`);
    }
    io.out(JSON.stringify({ terminal: answer.terminal, pane_id: answer.pane_id, ...(answer.first_message ? { first_message: answer.first_message } : {}) }));
    return answer.first_message?.state === "held" ? START_HELD_EXIT : 0;
  } catch (error) {
    if (!(error instanceof StartStop)) throw error;
    return report(io, "ovis start", json, error);
  }
}

interface PaneShown { pane_id: string; terminal_id?: string; agent_status?: string; status_basis?: string }

const realAfter = (ms: number, fire: () => void) => {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
};

/** One `ovis wait <machine> <terminal> --until ...` run; resolves with its exit code. */
export async function runWait(args: readonly string[], io: StartIo): Promise<number> {
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") { io.out(START_HELP); return 0; }
  let json = args.includes("--json");
  try {
    const parsed = split(args, ["--until", "--timeout"], false);
    json = parsed.json;
    if (parsed.rest.length > 0) throw usage("ovis wait takes nothing after --");
    if (parsed.positional.length !== 2) throw usage("usage: ovis wait <machine> <terminal> --until idle,blocked,done [--timeout <seconds>]");
    const untilText = parsed.named.get("--until");
    if (untilText?.length !== 1) throw usage("--until names the states to wait for, once: idle, blocked, done, working");
    const until = new Set(untilText[0]!.split(",").map((word) => word.trim()));
    if (until.size === 0 || [...until].some((word) => !(WAIT_STATES as readonly string[]).includes(word))) throw usage(`--until takes ${WAIT_STATES.join(", ")}`);
    const timeoutText = parsed.named.get("--timeout");
    if ((timeoutText?.length ?? 0) > 1) throw usage("--timeout may be given once");
    const timeoutS = seconds(timeoutText?.[0], undefined, 86_400, "--timeout");
    const [wanted, terminal] = parsed.positional as [string, string];
    const bridge = await bridgeOf(io, wanted);
    const after = io.after ?? realAfter;
    const settled = await new Promise<{ shown: { state: string; derived: boolean; basis: string | null } } | { timeout: true } | { ended: true } | StartStop>((resolve) => {
      const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
      const socket = new Socket(`ws://127.0.0.1:${bridge.port}/ws`, { headers: { authorization: `Bearer ${bridge.token}` } });
      let done = false;
      let paneId: string | null = null;
      let basis: string | null = null;
      let cancel = (): void => {};
      const finish = (result: Parameters<typeof resolve>[0]) => {
        if (done) return;
        done = true;
        cancel();
        try { socket.close(); } catch { /* closed already */ }
        resolve(result);
      };
      if (timeoutS !== undefined) {
        const stop = after(Math.round(timeoutS * 1000), () => finish({ timeout: true }));
        if (done) stop(); else cancel = stop;
      }
      const consider = (state: string | undefined) => {
        if (state !== undefined && until.has(state as WaitState)) finish({ shown: { state, derived: basis === "screen", basis } });
      };
      socket.onmessage = (event) => {
        let frame: { type?: string; snapshot?: { panes?: PaneShown[] }; pane_id?: string; agent_status?: string; code?: string; message?: string };
        try { frame = JSON.parse(String(event.data)); } catch { return; }
        if (frame.type === "snapshot") {
          const pane = frame.snapshot?.panes?.find((candidate) => candidate.pane_id === terminal || candidate.terminal_id === terminal);
          if (!pane) { finish(new StartStop(ON_EXIT.unknown, "unknown_terminal", `${bridge.name} has no terminal ${terminal}.`)); return; }
          if (paneId === null) io.following?.();
          paneId = pane.pane_id;
          basis = pane.status_basis ?? null;
          consider(pane.agent_status);
        } else if (frame.type === "pane-status" && paneId !== null && frame.pane_id === paneId) {
          consider(frame.agent_status);
        } else if (frame.type === "pane-exited" && paneId !== null && frame.pane_id === paneId) {
          finish({ ended: true });
        } else if (frame.type === "error" && paneId === null) {
          finish(new StartStop(ON_EXIT.unreachable, frame.code ?? "snapshot_failed", `${bridge.name}'s bridge could not read its terminals: ${frame.message ?? ""}`));
        }
      };
      socket.onclose = () => finish(new StartStop(ON_EXIT.unreachable, "bridge_closed", `${bridge.name}'s bridge closed the status stream.`));
      socket.onerror = () => finish(new StartStop(ON_EXIT.unreachable, "bridge_unreachable", `${bridge.name}'s bridge did not answer through this controller.`));
    });
    if (settled instanceof StartStop) throw settled;
    if ("ended" in settled) {
      if (json) io.err(JSON.stringify({ error: { origin: "ovis wait", code: "terminal_ended", message: `${terminal} ended before it showed ${[...until].join(", ")}`, exit_code: WAIT_ENDED_EXIT } }));
      else io.err(`ovis wait: ${terminal} ended before it showed ${[...until].join(", ")}`);
      return WAIT_ENDED_EXIT;
    }
    if ("timeout" in settled) {
      if (json) io.err(JSON.stringify({ error: { origin: "ovis wait", code: "timeout", message: `${terminal} did not show ${[...until].join(", ")} within ${timeoutS} s`, exit_code: WAIT_TIMEOUT_EXIT } }));
      else io.err(`ovis wait: ${terminal} did not show ${[...until].join(", ")} within ${timeoutS} s`);
      return WAIT_TIMEOUT_EXIT;
    }
    io.out(JSON.stringify(settled.shown));
    return 0;
  } catch (error) {
    if (!(error instanceof StartStop)) throw error;
    return report(io, "ovis wait", json, error);
  }
}
