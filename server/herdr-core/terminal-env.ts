import { loginEnvProbe, loginShell } from "../shell-agent.ts";
import { SERVER_ENV } from "./connection.ts";

type Env = Record<string, string>;

/**
 * What the login shell is run with: the session's own variables (who, where, locale, the
 * desktop's agents and buses), nothing else of this process's. A server a service or an agent's
 * shell started carries that one's environment (NO_COLOR, TERM=dumb, tokens filtered out), which
 * the login shell would hand back as the user's.
 */
const SESSION_ENV = /^(?:HOME|USER|LOGNAME|SHELL|PATH|LANG|LC_[A-Z_]+|TZ|TMPDIR|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|SSH_AUTH_SOCK|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY)$/;

/** The shell's own bookkeeping, and what places a process in a terminal or core: never the user's setting. */
const NOT_SETTINGS = /^(?:PWD|OLDPWD|SHLVL|_|TERM|COLORTERM|HC_.*|HERDR_.*)$/;

/** Where hc finds its core: a connect that starts one keeps this server's, whatever the profile says. */
const CORE_PLACE = /^(?:HOME|HC_.*|XDG_.*)$/;

const COLOUR: Env = { TERM: "xterm-256color", COLORTERM: "truecolor" };

/**
 * The environment of each terminal Ovis starts on herdr-core, given over whatever the core's own
 * is (hc hands every terminal the environment of the process that started the core, herdr-core#86):
 * the user's login shell's, without this server's own variables, in colour. NO_COLOR is set empty,
 * which turns it off, unless the login sets it: one the core inherited from an agent's shell would
 * stay otherwise, and hc cannot drop a variable. With no login environment, only the colour; on
 * Windows nothing (no login shell, and a console takes no TERM).
 */
export async function loginTerminalEnv(options: { env?: Record<string, string | undefined>; shell?: string | null; timeoutMs?: number } = {}): Promise<Env> {
  const source = options.env ?? process.env;
  const shell = options.shell === undefined ? loginShell(source) : options.shell;
  if (process.platform === "win32") return {};
  if (shell === null) return { ...COLOUR };
  const base = Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined && SESSION_ENV.test(entry[0])));
  const login = await loginEnvProbe({ shell, env: { ...base, ...COLOUR }, timeoutMs: options.timeoutMs ?? 3000 })(new AbortController().signal);
  if (login.value === null) {
    console.warn(`[herdr-core] terminals start without the login shell's environment: ${login.reason}`);
    return { ...COLOUR };
  }
  const kept = Object.entries(login.value).filter(([name]) => !NOT_SETTINGS.test(name) && !SERVER_ENV.test(name));
  return { ...Object.fromEntries(kept), NO_COLOR: login.value["NO_COLOR"] ?? "", ...COLOUR };
}

const read = new Map<string, Promise<Env>>();

/** loginTerminalEnv for `env` (this process's), read once per user and shell. */
export function userTerminalEnv(env: Record<string, string | undefined> = process.env): Promise<Env> {
  const key = `${env["HOME"] ?? ""}\0${env["SHELL"] ?? ""}`;
  let found = read.get(key);
  if (!found) { found = loginTerminalEnv({ env }); read.set(key, found); }
  return found;
}

/** What `hc connect` runs in: `base` with the terminal environment over it, a core it starts found where `base` says. */
export function coreStartEnv(base: Record<string, string | undefined>, terminal: Env): Record<string, string | undefined> {
  return { ...base, ...terminal, ...Object.fromEntries(Object.entries(base).filter(([name]) => CORE_PLACE.test(name))) };
}
