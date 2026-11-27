import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import chatSource from "../../integrations/cmd-chat.ts" with { type: "text" };
import sessionSource from "../../integrations/cmd-session.ts" with { type: "text" };
import { meetsMinVersion } from "../../shared/agent-catalog.ts";
import { permissionDecision, runTurn } from "./extension.ts";
import { showable, type ApprovalAdapter, type ApprovalRequest } from "./hub.ts";
import { shellCommandLine } from "../shell-agent.ts";

const CHAT_WAIT_MS = 5 * 60_000;

/** Resolve cmd inside the pane, not against the service PATH. Keep a workspace override unmodified. */
export function cmdLauncher(mod: string, probed: string, args: readonly string[]): string {
  const path = join(dirname(mod), "launch");
  const quote = (word: string) => shellCommandLine("posix", word, []);
  writeFileSync(path, [
    "#!/bin/sh", "set -- " + args.map(quote).join(" "), "cmd=$(command -v cmd) || exit 127",
    `if [ "$cmd" = ${quote(probed)} ]; then exec "$cmd" --mod ${quote(mod)} "$@"; fi`,
    'exec cmd "$@"', "",
  ].join("\n"), { mode: 0o700, flag: "wx" });
  return path;
}
const words = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && value.length <= 12_000 && showable(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function toCard(event: unknown): ApprovalRequest | null {
  if (!record(event)) return null;
  const permission = event.permission;
  if (record(permission)) {
    if (!words(permission.toolName) || !record(permission.input) || (permission.description !== null && typeof permission.description !== "string")) return null;
    return { command: `${permission.toolName}\n${JSON.stringify(permission.input, null, 2)}`, description: permission.description || null };
  }
  const q = event.question;
  if (!record(q) || !words(q.question) || !words(q.header) || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4
    || (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean")) return null;
  const labels: string[] = [], descriptions: string[] = [];
  for (const option of q.options) {
    if (!record(option) || !words(option.label) || (option.description !== undefined && option.description !== "" && !words(option.description))
      || labels.includes(option.label) || option.preview !== undefined) return null;
    labels.push(option.label);
    descriptions.push(option.description ?? "");
  }
  return { command: q.question, description: q.header, question: { text: q.question, options: labels, descriptions, multiple: q.multiSelect === true } };
}

export const cmdApprovals: ApprovalAdapter = {
  kind: "cmd",
  chatWaitMs: CHAT_WAIT_MS,
  supports: (version) => version.startsWith("1.") && meetsMinVersion(version, "1.93.4"),
  launchArgs(args, hook, dir) {
    if (args?.includes("--safe-mode")) return null;
    const mod = resolve(dir, `${randomUUID()}.plugin`);
    mkdirSync(mod, { mode: 0o700 });
    // Bun embeds both sources in the compiled server; Command Code's TS loader reads ordinary files.
    const write = (name: string, source: string) => writeFileSync(join(mod, name), source, { flag: "wx", mode: 0o600 });
    write("session.ts", `${sessionSource}`);
    write("chat.ts", `${chatSource}`);
    write("ovis-chat-bridge.ts", `import session from "./session.ts";\nimport chatMod from "./chat.ts";\nexport default cmd => session(cmd, chatMod(cmd, ${JSON.stringify({ ...hook, timeout: CHAT_WAIT_MS })}));\n`);
    return ["--mod", join(mod, "ovis-chat-bridge.ts"), ...args ?? []];
  },
  toCard,
  turn: runTurn,
  session(event) {
    if (!record(event)) return null;
    if (event.ended === null) return { ended: null };
    const id = event.session ?? event.ended;
    return typeof id === "string" && /^[\w-]{1,128}$/.test(id) ? event.session === id ? { session: id } : { ended: id } : null;
  },
  decision: permissionDecision,
  toAnswer: (decision, answered) => JSON.stringify(answered ? { answer: Object.values(answered.answers)[0] } : decision ?? "pass"),
};
