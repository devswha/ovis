
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [port, proj, out, only] = process.argv.slice(2);
const H = ["herdr", "--session", "chw"];
const env = { ...process.env, XDG_CONFIG_HOME: process.env.QA_XDG! };
const log = (row: Record<string, unknown>) => { appendFileSync(out, JSON.stringify({ at: Date.now(), ...row }) + "\n"); console.log(JSON.stringify(row).slice(0, 400)); };
const herdr = async (...args: string[]) => { const p = Bun.spawn([...H, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" }); const text = await new Response(p.stdout).text(); await p.exited; return text; };
const api = async (route: string, body?: unknown) => {
  const r = await fetch("http://127.0.0.1:" + port + "/api/" + route, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
const sleep = (ms: number) => Bun.sleep(ms);
const screen = async (pane: string) => (await herdr("pane", "read", pane)).replace(/\s+$/, "");
async function until<T>(f: () => Promise<T | null | undefined | false>, ms: number, step = 150): Promise<T | null> { const end = Date.now() + ms; while (Date.now() < end) { const v = await f(); if (v) return v as T; await sleep(step); } return null; }
const say = async (pane: string, text: string) => { await herdr("pane", "send-text", pane, text); await sleep(300); await herdr("pane", "send-keys", pane, "Enter"); };
const ovisStatus = async (pane: string) => ((await api("session")).json?.snapshot?.panes ?? []).find((p: any) => p.pane_id === pane)?.agent_status;
const herdrStatus = async (pane: string) => JSON.parse(await herdr("pane", "get", pane)).result?.pane?.agent_status;

let pane = process.env.QA_PANE ?? "";
if (!pane) {
  const made = await api("workspace/create", { cwd: proj, label: "qa", agent: { kind: "claude", args: ["--model", "claude-haiku-4-5-20251001"] } });
  pane = made.json?.pane_id ?? made.json?.pane?.pane_id;
  log({ step: "launch", status: made.status, pane, body: made.json });
}
if (!(await until(async () => /\? for shortcuts|manual mode/.test(await screen(pane)), 60000))) { log({ step: "boot-failed", screen: (await screen(pane)).slice(-1500) }); process.exit(1); }
await sleep(1500);

const readCard = async () => { const p = (await api("pane/prompt?pane_id=" + encodeURIComponent(pane))).json?.prompt; return p && p.kind === "approval" ? p : null; };
let firstUnbound = false;
async function card(ms = 90000) {
  const first = await until(readCard, ms);
  if (!first) return null;
  firstUnbound = !bound(first);
  // the hook's request can come a moment after the dialog is drawn: the card a person sees turns into the held one
  return (await until(async () => { const p = await readCard(); return p && bound(p) ? p : null; }, 4000)) ?? first;
}
async function answer(p: any, yes: boolean) {
  const index = p.options.findIndex((o: any) => yes ? o.label === "Yes" : /^No\b/.test(o.label));
  return api("pane/prompt/answer", { pane_id: pane, prompt_id: p.id, option_index: index });
}
async function rest(ms = 90000) { return until(async () => { const s = await ovisStatus(pane); return s === "done" || s === "idle" ? s : null; }, ms); }
const bound = (p: any) => /\.[0-9a-f]{16}$/.test(p.id);

async function approval(name: string, prompt: string, yes: boolean, check: (p: any) => Promise<Record<string, unknown>>) {
  await say(pane, prompt);
  const p = await card();
  if (!p) { log({ step: name, ok: false, why: "no card", screen: (await screen(pane)).slice(-1200) }); return; }
  const r = await answer(p, yes);
  await until(async () => (await herdrStatus(pane)) === "working", 4000, 100);
  await rest();
  await until(async () => (await herdrStatus(pane)) !== "working", 60000, 200);
  await sleep(800);
  const extra = await check(p);
  log({ step: name, decision: yes ? "allow" : "deny", bound: bound(p), firstUnbound, title: p.title, body: p.body, answer: r.status, ...extra });
}

if (!only || only === "write") {
  for (let i = 1; i <= 3; i++) {
    const file = "yes-" + i + ".txt";
    await approval("write-allow-" + i, "Use the Write tool to create " + file + " with exactly these two lines: 'approved " + i + "' and '안녕 \"q" + i + "\"'. Do nothing else.", true, async (p) => {
      const written = existsSync(proj + "/" + file) ? readFileSync(proj + "/" + file, "utf8") : null;
      return { file, written, cardEqualsFile: written !== null && p.body === file + "\n" + written };
    });
  }
  for (let i = 1; i <= 3; i++) {
    const file = "no-" + i + ".txt";
    await approval("write-deny-" + i, "Use the Write tool to create " + file + " containing 'denied " + i + "'. Do nothing else.", false, async (p) => {
      return { file, exists: existsSync(proj + "/" + file), cardNamesFile: String(p.body).startsWith(file + "\n"), screenTail: (await screen(pane)).split("\n").slice(-6).join("\n") };
    });
  }
}
if (!only || only === "other") {
  await approval("edit-allow", "Use the Edit tool on notes.txt to replace the line 'beta' with 'beta (edited)'. Do nothing else.", true, async (p) => ({ file: readFileSync(proj + "/notes.txt", "utf8") }));
  await approval("webfetch-allow", "Use the WebFetch tool to fetch https://example.com/ and tell me its title in one line. Do nothing else.", true, async () => ({ tail: (await screen(pane)).split("\n").filter(Boolean).slice(-5).join("\n") }));
  await approval("mcp-allow", "Call the MCP tool shout from the echo server with message 'ovis 확인' . Do nothing else.", true, async () => ({ tail: (await screen(pane)).split("\n").filter(Boolean).slice(-5).join("\n") }));
}
if (!only || only === "bash") {
  const commands: [string, string][] = [
    ["short", "touch short-ok.txt"],
    ["long", "ls -la /usr/share/doc | head -n 3 && echo 'a long one-line command that wraps past the width of the pane for sure, 1234567890 1234567890'"],
    ["heredoc", "cat <<'EOF' > here.txt\nline one\n\tline two with a tab\nEOF"],
    ["quotes", "printf '%s\\n' \"한글 따옴표 'single' \\\"double\\\"\" > quotes.txt"],
  ];
  for (const [name, command] of commands) {
    writeFileSync(proj + "/cmds/" + name + ".txt", command);
    await approval("bash-" + name, "Read the file cmds/" + name + ".txt and run its whole content as ONE Bash tool call, byte for byte. Then reply only: done", true, async (p) => {
      const lines = String(p.body).split("\n");
      return { cardHasCommand: String(p.body).endsWith(command), command };
    });
  }
}
if (!only || only === "turns") {
  for (let i = 1; i <= 10; i++) {
    const before = Date.now();
    await say(pane, "Reply with only the word ok" + i + ".");
    await until(async () => (await ovisStatus(pane)) === "working", 30000, 100);
    const seen: Record<string, number | undefined> = {};
    await until(async () => {
      const [o, h] = await Promise.all([ovisStatus(pane), herdrStatus(pane)]);
      if ((o === "done" || o === "idle") && seen.ovis === undefined) { seen.ovis = Date.now(); seen.ovisStatus = o as any; }
      if ((h === "done" || h === "idle") && seen.herdr === undefined) seen.herdr = Date.now();
      return seen.ovis !== undefined && seen.herdr !== undefined;
    }, 90000, 100);
    log({ step: "turn-" + i, sent: before, ovisRest: seen.ovis, ovisStatus: seen.ovisStatus, herdrRest: seen.herdr });
    await sleep(1500);
  }
}
log({ step: "end", pane });
