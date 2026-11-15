/**
 * One machine of a world, seen from the host: everything goes through `docker exec` into its container, so a caller
 * never needs a port of the machine. What it offers is primitives (engine, sessions, server, terminals, extra
 * processes, power), never a scenario.
 */
import { readFileSync } from "node:fs";
import { docker, run, withEnvFile, type Ran } from "./docker.ts";
import { lastQrLink } from "./qr.ts";
import { describePreset, PLUGIN_ID, PRESET_NAME, presetSteps, type Preset } from "./standins.ts";
import type { Engine, MachineStart } from "./plan.ts";

export interface MachineDescription {
  readonly name: string;
  readonly container: string;
  readonly ip: string;
  readonly engine: Engine;
  readonly start: MachineStart;
  /** a systemd user manager answers `systemctl --user` for the machine's user */
  readonly systemd: boolean;
  /** the machine's user; absent in descriptions written before it existed: runner, uid 1001 */
  readonly user?: { readonly name: string; readonly uid: number; readonly home: string };
  readonly hostname?: string;
  /** B5: the stand-in this machine is, brought up by its steps */
  readonly preset?: Preset;
  /** the ordinary Ovis server, on the machine's own loopback */
  readonly server: string;
}

export class MachineError extends Error {
  constructor(machine: string, what: string, ran: Ran) {
    super(`${machine}: ${what} exited ${ran.code}: ${(ran.err + ran.out).trim().slice(-600)}`);
    this.name = "MachineError";
  }
}

const INSIDE = "/opt/world/inside";

async function within(what: string, ms: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(200);
  }
}

export const RUNNER = { name: "runner", uid: 1001, home: "/home/runner" } as const;

/** Which server a call goes to (Machine.serverCall): the state folder and TCP port of a server the caller started. */
export interface ServerCall {
  readonly state: string;
  readonly port: number;
  readonly method?: string;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A call's headers as the lines of a curl `-H @file`; a name or value that would break a line is refused. */
export function headerLines(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers).map(([name, value]) => {
    if (!/^[A-Za-z0-9-]+$/.test(name) || /[\r\n\0]/.test(value)) throw new Error(`header ${JSON.stringify(name)}: a name of letters, digits and -, and a value on one line`);
    return `${name}: ${value}\n`;
  }).join("");
}

/** The argv of one call (inside/serve-call.sh) to the server named by `call`; the headers only by their file's name. */
export function serverCallArgv(route: string, call: ServerCall, headerFile: string | null, script = `${INSIDE}/serve-call.sh`): string[] {
  if (!call.state.startsWith("/")) throw new Error(`state folder ${JSON.stringify(call.state)}: an absolute path`);
  if (!Number.isInteger(call.port) || call.port < 1 || call.port > 65535) throw new Error(`port ${call.port}: 1-65535`);
  if (call.method !== undefined && !/^[A-Z]+$/.test(call.method)) throw new Error(`method ${JSON.stringify(call.method)}: an HTTP method`);
  return ["sh", script, call.state, `http://127.0.0.1:${call.port}`, route, "-s", "-m", "10", "-w", "\n%{http_code}", "-X", call.method ?? "GET",
    ...headerFile === null ? [] : ["-H", `@${headerFile}`], ...call.body === undefined ? [] : ["--data-binary", "@-"]];
}

export class Machine {
  constructor(readonly description: MachineDescription) {}

  get name(): string { return this.description.name; }
  get user(): { readonly name: string; readonly uid: number; readonly home: string } { return this.description.user ?? RUNNER; }

  /**
   * A command in the machine (as its user, `runner` unless the machine has its own), with its output. `env` reaches the
   * command but never a command line on this PC (a token in it stays private) nor docker's own environment (PATH there
   * would steer docker): it goes in a 0600 env file (withEnvFile), with HOME. `input` is the command's stdin.
   */
  exec(argv: readonly string[], env: Readonly<Record<string, string>> = {}, input?: string): Promise<Ran> {
    const { uid, name, home } = this.user;
    const session: Record<string, string> = this.description.systemd ? { XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` } : {};
    return withEnvFile({ HOME: home, ...session, ...env }, (envFlag) =>
      run(["docker", "exec", ...(input === undefined ? [] : ["-i"]), "-u", name, "-w", home, ...envFlag, this.description.container, ...argv], input));
  }

  private async must(what: string, argv: readonly string[], env: Readonly<Record<string, string>> = {}, input?: string): Promise<string> {
    const ran = await this.exec(argv, env, input);
    if (ran.code !== 0) throw new MachineError(this.name, what, ran);
    return ran.out;
  }

  private inside(what: string, args: readonly string[]): Promise<string> {
    return this.must(what, ["bun", `${INSIDE}/machine.ts`, ...args]);
  }

  /** classic herdr's server (a named session with `session`), or herdr-core's core */
  engineStart(session?: string): Promise<string> { return this.inside("engine-start", ["engine-start", ...session ? [session] : []]); }
  engineStop(session?: string): Promise<string> { return this.inside("engine-stop", ["engine-stop", ...session ? [session] : []]); }
  /** a stand-in claude with a real transcript and prompt screen in a terminal of the engine (of `session`) */
  agent(session?: string): Promise<string> { return this.inside("agent", ["agent", ...session ? [session] : []]); }
  hc(args: readonly string[]): Promise<string> { return this.inside("hc", ["hc", ...args]); }

  async serverStart(): Promise<void> {
    await this.must("server start", ["sh", "-c", `nohup bun ${INSIDE}/machine.ts server >> "$HOME/server.log" 2>&1 &`]);
    await within(`${this.name}: the server's health`, 60_000, async () => (await this.health()) !== null);
  }

  /**
   * B6: the server from exactly a start-line file (NAME=value lines, as the join writes it), copied into the machine;
   * `argv` runs another server than the checkout's (a kit's `<install>/bin/ovis-server serve`). Ready when PORT answers.
   */
  async serverStartFrom(hostFile: string, argv: readonly string[] = []): Promise<void> {
    const port = /^PORT=(\d+)$/m.exec(readFileSync(hostFile, "utf8"))?.[1] ?? "17611";
    await docker(["cp", hostFile, `${this.description.container}:${this.user.home}/start.env`]);
    await docker(["exec", "-u", "0", this.description.container, "chown", `${this.user.name}:${this.user.name}`, `${this.user.home}/start.env`]);
    await this.must("server start", ["sh", "-c", `nohup bun ${INSIDE}/machine.ts server-file "$HOME/start.env" "$@" >> "$HOME/server.log" 2>&1 &`, "sh", ...argv]);
    await within(`${this.name}: the server on ${port}`, 60_000, async () => (await this.exec(["curl", "-s", "-m", "3", "-f", `http://127.0.0.1:${port}/api/health`])).code === 0);
  }

  /** B3: the link of the last QR code a terminal drew (`ovis add`), as text, read offline (qr.ts); null while none. */
  async pairingLink(label: string): Promise<string | null> { return lastQrLink(await this.recording(label)); }

  /**
   * B3 without polling: follows the terminal's recording as it is written (tail -F in the machine, ended there by its
   * own timeout too) and gives the first QR link that `accept` takes; null when none came within `ms`.
   */
  async qrLink(label: string, accept: (link: string) => boolean, ms: number): Promise<string | null> {
    const file = `${this.user.home}/term-${label}.out`;
    const child = Bun.spawn(["docker", "exec", "-u", this.user.name, this.description.container, "timeout", String(Math.ceil(ms / 1000) + 1), "tail", "-c", "+1", "-F", file],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), ms);
    const decoder = new TextDecoder();
    let text = "";
    try {
      for await (const chunk of child.stdout) {
        text += decoder.decode(chunk, { stream: true });
        const link = lastQrLink(text);
        if (link !== null && accept(link)) return link;
      }
      return null;
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  }

  /**
   * A scripted member device with no browser, run in this machine (inside/member.ts): it signs in to the test account
   * with `passphrase` (sent on stdin, never an argument), pairs through the world's relay from `link` (a machine's
   * `ovis add` pairing link) and calls that machine's /api/account/link and /api/account/enroll, all with the
   * checkout's own client code. `skip`: a device that never pairs and signs in with a pairing it made up. Its steps
   * come back as parsed lines, the last one `done`.
   */
  async memberDevice(mode: "member" | "skip", link: string, passphrase: string): Promise<{ readonly code: number; readonly steps: readonly Record<string, unknown>[]; readonly err: string }> {
    // both on stdin: the passphrase and the link (a bearer capability) are on no command line, here or in the machine
    const ran = await this.exec(["timeout", "120", "bun", `${INSIDE}/member.ts`, mode], {}, `${passphrase}\n${link}\n`);
    const steps = ran.out.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
    return { code: ran.code, steps, err: ran.err };
  }

  async serverStop(): Promise<void> {
    await this.exec(["pkill", "-TERM", "-f", `${INSIDE}/machine.ts server`]);
    await within(`${this.name}: the server to stop`, 30_000, async () => (await this.exec(["pgrep", "-f", "server/index.ts"])).code !== 0);
  }

  async serverRestart(): Promise<void> { await this.serverStop(); await this.serverStart(); }

  /**
   * One call to an owner route of a server this machine runs, the one the caller names: its state folder and TCP port
   * (the caller started it, so it knows them; nothing is guessed from the process table). Through `<state>/serve.sock`
   * when that server has the socket, over TCP otherwise (inside/serve-call.sh). Headers go in a 0600 file in the
   * machine (`-H @file`, removed after), never on a command line; `body` goes on stdin. Health is not called this way:
   * it is read over TCP (health()).
   */
  async serverCall(route: string, call: ServerCall): Promise<{ readonly status: number; readonly body: string }> {
    const headers = headerLines(call.headers ?? {});
    const file = headers === "" ? null : (await this.must("server call headers", ["sh", "-c", 'umask 077; f=$(mktemp); cat > "$f"; printf %s "$f"'], {}, headers)).trim();
    try {
      const ran = await this.exec(serverCallArgv(route, call, file), {}, call.body);
      if (ran.code !== 0) throw new MachineError(this.name, `server call ${route}`, ran);
      const at = ran.out.lastIndexOf("\n");
      return { status: Number(ran.out.slice(at + 1)), body: ran.out.slice(0, at) };
    } finally {
      if (file !== null) await this.exec(["rm", "-f", file]);
    }
  }

  /** GET /api/health of the machine's server, or null while it does not answer */
  async health(): Promise<Record<string, unknown> | null> {
    const ran = await this.exec(["curl", "-s", "-m", "3", "-f", `${this.description.server}/api/health`]);
    if (ran.code !== 0) return null;
    try { return JSON.parse(ran.out) as Record<string, unknown>; } catch { return null; }
  }

  /** The process table, for "nothing was started" proofs. */
  ps(): Promise<string> { return this.must("ps", ["ps", "-eo", "pid,ppid,user,comm,args"]); }

  readFile(path: string): Promise<string> { return this.must(`read ${path}`, ["sh", "-c", 'cat "$0"', path]); }

  /**
   * Runs `commandLine` on the machine's REAL terminal (a pty of script(1), with the server's environment, in the
   * checkout): its screen is recorded, `type` sends keys to it. `ovis add` is `bun scripts/plugin.ts add`.
   */
  async terminal(label: string, commandLine: string): Promise<void> {
    if (!/^[a-z0-9-]{1,32}$/.test(label)) throw new Error(`terminal label ${label}: a-z 0-9 -`);
    // the command line may carry a token: it travels in an env file, never on this PC's command lines
    await withEnvFile({ HOME: this.user.home, WORLD_TERM_CMD: commandLine }, (envFlag) => docker(["exec", "-d", "-u", this.user.name, "-w", this.user.home, ...envFlag, this.description.container, "sh", `${INSIDE}/term.sh`, label]));
    await within(`${this.name}: terminal ${label}`, 10_000, async () => (await this.exec(["test", "-p", `${this.user.home}/term-${label}.in`])).code === 0);
  }

  async type(label: string, text: string): Promise<void> {
    // the text goes on stdin (what is typed may be a passphrase: never on a command line); a terminal that has ended
    // has no reader: give up after 5 s instead of blocking on the fifo
    await this.must(`type into ${label}`, ["timeout", "5", "sh", "-c", 'cat > "$HOME/term-$0.in"', label], {}, text);
  }

  recording(label: string): Promise<string> { return this.readFile(`${this.user.home}/term-${label}.out`); }

  /** An extra process of the caller's (a second Ovis, another state folder): its output goes to ~/bg-<label>.log. */
  async background(label: string, argv: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<number> {
    if (!/^[a-z0-9-]{1,32}$/.test(label)) throw new Error(`process label ${label}: a-z 0-9 -`);
    await this.must(`start ${label}`, ["sh", "-c", 'label=$0; nohup "$@" > "$HOME/bg-$label.log" 2>&1 & echo $! > "$HOME/bg-$label.pid"', label, ...argv], env);
    return Number((await this.readFile(`${this.user.home}/bg-${label}.pid`)).trim());
  }

  async stopBackground(label: string): Promise<void> {
    await this.exec(["sh", "-c", 'kill -TERM "$(cat "$HOME/bg-$0.pid")" 2>/dev/null; true', label]);
  }

  /**
   * The stand-in agent of `session` (default: the default session): its pid, what it was typed and answered, and its
   * controls. ask() puts its question up again (SIGUSR1), freeze()/thaw() stop and continue the process, finish() ends it.
   */
  standIn(session = "default") {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(session)) throw new Error(`stand-in session ${JSON.stringify(session)}: a-z 0-9 -`);
    const home = this.user.home;
    const pid = async () => Number((await this.readFile(`${home}/ready-${session}`)).trim());
    const signal = async (name: string) => { await this.must(`${name} the stand-in`, ["kill", `-${name}`, String(await pid())]); };
    return {
      pid,
      inputs: async () => (await this.readFile(`${home}/input-${session}.jsonl`)).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string),
      answers: async () => (await this.readFile(`${home}/answers-${session}`)).split("\n").filter(Boolean),
      asks: async () => (await this.exec(["sh", "-c", 'cat "$0" 2>/dev/null', `${home}/asks-${session}`])).out.split("\n").filter(Boolean).length,
      alive: async () => (await this.exec(["kill", "-0", String(await pid())])).code === 0,
      frozen: async () => /^T/.test((await this.must("state", ["ps", "-o", "stat=", "-p", String(await pid())])).trim()),
      freeze: () => signal("STOP"), thaw: () => signal("CONT"), finish: () => signal("TERM"),
      ask: () => signal("USR1"),
    };
  }

  /** A process as a user unit of the machine's systemd user manager (a :systemd machine), as a trial's own unit is. */
  async unit(name: string, argv: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<void> {
    if (!this.description.systemd) throw new Error(`${this.name} has no systemd user manager (start it as <name>:<engine>:<start>:systemd)`);
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) throw new Error(`unit name ${JSON.stringify(name)}: a-z 0-9 -`);
    // the unit's environment goes in a 0600 file the unit reads (EnvironmentFile), written from stdin: on no command line
    const file = `/run/user/${this.user.uid}/world-unit-${name}.env`;
    const lines = Object.entries(env).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) throw new Error(`unit ${name}: environment ${key}: a name of letters, digits and _, and a value on one line`);
      return `${key}=${value}\n`;
    }).join("");
    await this.must(`unit ${name} environment`, ["sh", "-c", 'umask 077; cat > "$0"', file], {}, lines);
    await this.must(`unit ${name}`, ["systemd-run", "--user", `--unit=${name}`, `--property=EnvironmentFile=${file}`, ...argv]);
  }

  async stopUnit(name: string): Promise<void> { await this.exec(["systemctl", "--user", "stop", name]); }

  /**
   * A stand-in `tailscale` on the machine's PATH that answers `tailscale status --json` naming `owner` and refuses every
   * other command: a script in the sealed container, nothing to do with this PC's tailscale.
   */
  async fakeTailscale(owner: string): Promise<void> {
    const status = JSON.stringify({ BackendState: "Running", Self: { HostName: this.description.hostname ?? `${this.name}-box`, UserID: 1, Online: true }, User: { "1": { ID: 1, LoginName: owner, DisplayName: owner } } });
    const script = `#!/bin/sh\nif [ "$1" = status ] && [ "$2" = --json ]; then printf '%s\\n' '${status.replaceAll("'", "")}'; exit 0; fi\necho "tailscale (world stand-in): only 'status --json'" >&2; exit 1\n`;
    await docker(["exec", "-u", "0", this.description.container, "sh", "-c", 'printf "%s" "$0" > /usr/local/bin/tailscale && chmod 755 /usr/local/bin/tailscale', script]);
  }

  /** Power: the container stops (every process in it ends) and starts again with nothing running but its idle first process. */
  async powerOff(): Promise<void> { await docker(["stop", "-t", "2", this.description.container]); }
  async powerOn(): Promise<void> {
    await docker(["start", this.description.container]);
    await within(`${this.name}: running`, 15_000, async () => (await docker(["inspect", "-f", "{{.State.Running}}", this.description.container])) === "true");
  }

  /** What `start` asks for, run in order: the engine, the stand-in agent, the server. */
  async bringUp(): Promise<void> {
    if (this.description.preset) {
      for (const step of presetSteps(this.description.preset)) console.error(`${this.name} ${step}: ${(await this.must(`${PRESET_NAME} ${step}`, ["sh", `${INSIDE}/${PRESET_NAME}.sh`, step], { WORLD_INSIDE: INSIDE, WORLD_PLUGIN_ID: PLUGIN_ID })).trim()}`);
      console.error(`${this.name}: ${describePreset(this.description.preset)}`);
      return;
    }
    if (this.description.start === "none") return;
    await this.engineStart();
    if (this.description.start === "engine") return;
    await this.agent();
    await this.serverStart();
  }
}
