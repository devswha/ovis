/**
 * `ovis-server approval-hook --socket <address> --launch <key>`: the command an agent Ovis starts runs for each approval
 * its hook asks (server/approvals/hub.ts). It sends the event on stdin to the hub at `address` (a unix socket, a named
 * pipe on Windows) and prints the hub's answer. No hub, a refusal, an answer not signed with this launch's key, or any
 * other failure prints nothing and exits 0, which the agent reads as no decision: its own dialog stands. It has no time
 * limit of its own; the agent's hook timeout ends it.
 *
 * The key never goes over the wire. The request carries the key's digest and an HMAC of the event under the key, and
 * the hub's answer an HMAC of the answer under it: a hub that does not hold the key (another account's listener at the
 * address once Ovis stopped, as anyone can make a named pipe of a free name) can neither learn it nor answer.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { connect } from "node:net";

/** The most of a line either side sends: an event, JSON-escaped, and its envelope. */
export const LINE_MAX = 2 * 1024 * 1024;

export const keyDigest = (key: string): string => createHash("sha256").update(key).digest("hex");

/** The signature of `text` under a launch's key, for one side (`request` or `answer`) of one exchange (`nonce`). */
export const signed = (key: string, side: "request" | "answer", nonce: string, text: string): string =>
  createHmac("sha256", key).update(`${side}\n${nonce}\n${text}`).digest("hex");

export function sameSignature(given: unknown, expected: string): boolean {
  return typeof given === "string" && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function relayOptions(argv: readonly string[]): { socket: string; launch: string } | null {
  const value = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 && typeof argv[at + 1] === "string" && argv[at + 1] !== "" ? argv[at + 1]! : null;
  };
  const socket = value("--socket"), launch = value("--launch");
  return socket === null || launch === null ? null : { socket, launch };
}

/**
 * Whether Bun was told to load a module before this one (its flags, or BUN_OPTIONS): code from wherever the agent runs
 * the hook. Such a run answers nothing. A bunfig.toml's preload does not show here; the hook's command keeps Bun from
 * reading the working folder's (relayCommand in server/approvals/hub.ts).
 */
export const preloaded = (execArgv: readonly string[]): boolean => execArgv.some((arg) => /^(?:-r|--preload|--require|--import)(?:=|$)/.test(arg));

/** The hub's answer to `event`, verified, or null for none. */
export function relay(address: string, key: string, event: string): Promise<string | null> {
  const nonce = randomBytes(16).toString("hex");
  return new Promise((resolve) => {
    let received = "";
    let done = false;
    const finish = (answer: string | null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(answer);
    };
    const socket = connect(address);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ launch: keyDigest(key), nonce, proof: signed(key, "request", nonce, event), event })}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.length > LINE_MAX) return finish(null);
      const end = received.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = JSON.parse(received.slice(0, end)) as { answer?: unknown; proof?: unknown };
        finish(typeof reply.answer === "string" && sameSignature(reply.proof, signed(key, "answer", nonce, reply.answer)) ? reply.answer : null);
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

export async function runApprovalRelay(): Promise<void> {
  if (preloaded(process.execArgv)) return;
  const options = relayOptions(process.argv.slice(2));
  if (options === null) {
    console.error("usage: ovis-server approval-hook --socket <address> --launch <key>");
    process.exit(2);
  }
  const answer = await relay(options.socket, options.launch, await Bun.stdin.text());
  if (answer !== null) process.stdout.write(answer);
}

if (import.meta.main) await runApprovalRelay();
