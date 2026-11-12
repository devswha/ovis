/** Read-only native Codex discovery through one verified local tmux attach client. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProcessInfo } from "./herdr/client.ts";
import { processTable, type TerminalProcess } from "./kiro-terminal.ts";
import { processStartIdentity } from "./process-start.ts";
import { darwinArgv } from "./darwin-process.ts";
import { isCodexExecutable, isCodexInterpreter } from "./codex-executable.ts";

function attachClient(client: { pid: number; argv?: readonly string[] | null }) {
  const argv = client.argv ?? [];
  if (!/(?:^|\/)tmux$/.test(argv[0] ?? "")) return null;
  const args: string[] = [];
  let socket: string | null = null;
  let at = 1;
  while (argv[at]?.startsWith("-")) {
    const flag = argv[at++];
    if (flag === "-u" || flag === "-2") continue;
    if ((flag !== "-S" && flag !== "-L") || args.length > 0) return null;
    const value = argv[at++];
    if (!value || /[\r\n\t]/.test(value) || (flag === "-S" && !isAbsolute(value))) return null;
    args.push(flag, value);
    if (flag === "-S") socket = value;
  }
  if (!/^(?:attach-session|attach|at|a)$/.test(argv[at] ?? "")) return null;
  return { pid: client.pid, args, socket };
}

export function tmuxWrapper(info: ProcessInfo | undefined, platform = process.platform): boolean {
  return (platform === "linux" || platform === "darwin")
    && (info?.foreground_processes ?? []).some((process) => attachClient(process) !== null);
}

const FORMAT = "#{client_pid}\t#{client_tty}\t#{pid}\t#{socket_path}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{client_control_mode}\t#{pane_dead}";
const exec = promisify(execFile);
async function clients(args: string[]): Promise<string> {
  // Neither the bridge's own TMUX nor the attach command's old -t selects the client's current pane.
  const env = { ...process.env };
  delete env["TMUX"]; delete env["TMUX_PANE"];
  return (await exec("tmux", [...args, "list-clients", "-F", FORMAT],
    { env, timeout: 2000, maxBuffer: 128 * 1024 })).stdout;
}

const tty = (value: string) => value.replace(/^\/dev\//, "");
const pid = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const SHELL = /(?:^|\/)(?:sh|bash|dash|zsh)$/;

function processArgv(pid: number): string[] | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "darwin") return darwinArgv(pid);
    if (process.platform !== "linux") return null;
    const text = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!text.endsWith("\0")) return null;
    const words = text.split("\0");
    words.pop();
    return words.length > 0 && words[0] !== "" ? words : null;
  } catch { return null; }
}

/** Only the exact client's active pane and its one foreground native Codex, never a session-name guess. */
export async function tmuxCodexProcess(info: ProcessInfo | undefined, platform = process.platform,
  readClients = clients, readProcesses = processTable, birth = processStartIdentity,
  readArgv: (pid: number) => readonly string[] | null = processArgv,
): Promise<{ pid: number; argv: string[]; identity: string } | null> {
  const reported = info?.foreground_processes ?? [];
  const attachments = reported.map(attachClient).filter((client) => client !== null);
  if (!tmuxWrapper(info, platform) || attachments.length !== 1) return null;
  const client = attachments[0]!;
  try {
    const clientBirth = birth(client.pid);
    if (clientBirth === null) return null;
    const observe = async () => {
      const text = await readClients(client.args);
      const lines = text.trimEnd().split("\n").map((line) => line.split("\t"));
      const matches = lines.filter((fields) => fields[0] === String(client.pid));
      if (matches.length !== 1) return null;
      const fields = matches[0]!;
      const [clientPid, clientTty, serverPid, socket, session, window, pane, panePid, paneTty, control, dead] = fields;
      if (fields.length !== 11 || dead !== "0" || !pid(clientPid!) || !pid(serverPid!) || !pid(panePid!)
        || !isAbsolute(socket!) || (client.socket !== null && resolve(socket!) !== resolve(client.socket))
        || !/^\$\d+$/.test(session!) || !/^@\d+$/.test(window!) || !/^%\d+$/.test(pane!) || control !== "0"
        || !clientTty?.startsWith("/dev/") || !paneTty?.startsWith("/dev/") || clientTty === paneTty) return null;
      const rows = await readProcesses();
      const outer = rows.find((row) => row.pid === client.pid);
      const root = rows.find((row) => row.pid === Number(panePid));
      // Remain-on-exit keeps a dead pane's PID/TTY; only its live server-owned child is proof.
      if (!outer || outer.group !== outer.foreground || tty(outer.tty) !== tty(clientTty)
        || !root || root.parent !== Number(serverPid) || tty(root.tty) !== tty(paneTty)) return null;
      const outerChain = [outer];
      const expected = new Set(reported.map((process) => process.pid));
      if (expected.size !== reported.length) return null;
      if (reported.length > 1) {
        const shellPid = info?.shell_pid;
        if (shellPid === undefined || shellPid === null || !expected.has(shellPid)) return null;
        const seen = new Set([outer.pid]);
        while (outerChain.at(-1)!.pid !== shellPid) {
          const parent = rows.find((row) => row.pid === outerChain.at(-1)!.parent);
          if (!parent || seen.has(parent.pid) || !SHELL.test(parent.command)
            || tty(parent.tty) !== tty(clientTty) || parent.group !== outer.group
            || parent.foreground !== outer.foreground) return null;
          seen.add(parent.pid);
          outerChain.push(parent);
        }
      }
      // The reported and kernel foreground must both be exactly this chain, never filtered siblings.
      const outerForeground = rows.filter((row) => tty(row.tty) === tty(clientTty) && row.group === outer.group);
      if (outerForeground.length !== expected.size || outerChain.length !== expected.size
        || outerForeground.some((row) => !expected.has(row.pid) || !outerChain.includes(row))) return null;
      const foreground = rows.filter((row) => tty(row.tty) === tty(paneTty) && row.group === root.foreground);
      const candidates: { row: TerminalProcess; argv: string[]; argvBirth: number | null }[] = foreground
        .filter((row) => /(?:^|\/)codex(?:-(?:x86_64|aarch64)-[a-z0-9_-]+)?$/.test(row.command))
        .map((row) => ({ row, argv: [row.command], argvBirth: null }));
      // Existing native proof stays first; interpreter argv is evidence only for the script fallback.
      if (candidates.length === 0) for (const row of foreground) {
        const before = birth(row.pid);
        if (before === null) return null;
        const argv = readArgv(row.pid);
        if (argv === null || birth(row.pid) !== before) return null;
        // comm is mutable (Node may name its main thread); the kernel's argv names the interpreter.
        if (isCodexInterpreter(argv[0] ?? "") && isCodexExecutable(argv)) candidates.push({ row, argv: [...argv], argvBirth: before });
      }
      if (candidates.length !== 1) return null;
      const selected = candidates[0]!;
      const codex = selected.row;
      if (codex.group !== codex.foreground) return null;
      const chain: TerminalProcess[] = [codex];
      const seen = new Set([codex.pid]);
      while (chain.at(-1)!.pid !== root.pid) {
        const parent = rows.find((row) => row.pid === chain.at(-1)!.parent);
        if (!parent || seen.has(parent.pid) || tty(parent.tty) !== tty(paneTty)
          || !SHELL.test(parent.command)
          || (parent.pid !== root.pid && (parent.group !== root.foreground || parent.foreground !== root.foreground))) return null;
        seen.add(parent.pid);
        chain.push(parent);
      }
      // Every foreground member must belong to this one shell-to-Codex chain, never a sibling job.
      if (foreground.some((row) => !chain.includes(row))) return null;
      return { fields, outer, outerChain, root, codex, chain, argv: selected.argv, argvBirth: selected.argvBirth, server: Number(serverPid) };
    };
    const first = await observe();
    if (first === null) return null;
    const serverBirth = birth(first.server);
    const outerBirths = first.outerChain.map((row) => birth(row.pid));
    const chainBirths = first.chain.map((row) => birth(row.pid));
    if (serverBirth === null || [...outerBirths, ...chainBirths].some((value) => value === null)
      || (first.argvBirth !== null && chainBirths[0] !== first.argvBirth)) return null;
    const second = await observe();
    if (second === null || JSON.stringify(first) !== JSON.stringify(second)
      || birth(client.pid) !== clientBirth || birth(first.server) !== serverBirth
      || first.outerChain.some((row, index) => birth(row.pid) !== outerBirths[index])
      || first.chain.some((row, index) => birth(row.pid) !== chainBirths[index])) return null;
    const argvKey = first.argvBirth === null ? "" : `:${createHash("sha256").update(JSON.stringify(first.argv)).digest("hex")}`;
    const identity = `${first.fields.join(":")}:${clientBirth}:${serverBirth}:${first.outerChain.map((row, index) => `${row.pid}:${outerBirths[index]}`).join(",")}:${first.chain.map((row, index) => `${row.pid}:${chainBirths[index]}`).join(",")}${argvKey}`;
    return { pid: first.codex.pid, argv: first.argv, identity };
  } catch { return null; }
}
