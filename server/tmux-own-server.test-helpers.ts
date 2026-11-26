import { expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationResponse } from "../shared/protocol.ts";
import { paneSendText, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { shellQuote } from "./machine-security.ts";

export function testTmuxOwnAppServers({ root, socket, home, rollout, tmux, port }: {
  readonly root: string;
  readonly socket: string;
  readonly home: string;
  readonly rollout: string;
  readonly tmux: (...args: string[]) => Promise<string>;
  readonly port: () => number | undefined;
}): void {
  it.skipIf(process.platform !== "linux").each(["child", "sibling"] as const)("reads the locked rollout from a remote tmux TUI's %s app server", async (relation) => {
    const endpoint = `unix://${join(root, `${relation}.sock`)}`;
    const lockDir = join(home, "thread-writer-locks");
    mkdirSync(lockDir, { recursive: true });
    const lock = join(lockDir, "00000000-0000-4000-8000-000000000001.lock");
    const fixture = join(root, "own-server.py");
    const python = Bun.which("python3");
    if (python === null) throw new Error("The tmux fixture needs python3");
    writeFileSync(fixture, `import ctypes, fcntl, signal, socket, subprocess, sys
ctypes.CDLL(None).prctl(15, b"codex", 0, 0, 0)
signal.signal(signal.SIGHUP, lambda *_: sys.exit(0))
tmux = ["tmux", "-S", ${JSON.stringify(socket)}, "wait-for"]
ready = ${JSON.stringify(`${relation}-ready`)}
if sys.argv[1] == "app-server":
    rollout = open(${JSON.stringify(rollout)}, "r")
    lock = open(${JSON.stringify(lock)}, "w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(sys.argv[3][len("unix://"):])
    listener.listen()
    subprocess.run(tmux + ["-S", ready], check=True)
    signal.pause()
else:
    server = None
    if sys.argv[1] == "child":
        server = subprocess.Popen(["codex", __file__, "app-server", "--listen", sys.argv[3]], executable=${JSON.stringify(python)})
        subprocess.run(tmux + [ready], check=True)
    try:
        subprocess.run(tmux + ["-S", ready + "-tui"], check=True)
        sys.stdin.read()
    finally:
        if server is not None:
            server.terminate()
            server.wait()
`);
    const launch = (role: string, flag: string) =>
      [python, fixture, role, flag, endpoint].map(shellQuote).join(" ");
    const script = relation === "child" ? `exec -a codex ${launch(relation, "--remote")}` : [
      `(exec -a codex ${launch("app-server", "--listen")}) &`,
      "pid=$!",
      `trap 'kill "$pid" 2>/dev/null; wait "$pid"' EXIT`,
      `tmux -S ${shellQuote(socket)} wait-for ${relation}-ready`,
      `(exec -a codex ${launch(relation, "--remote")})`,
    ].join("\n");
    const launcher = join(root, `${relation}.sh`);
    writeFileSync(launcher, script);
    let remoteWorkspace: string | undefined;
    try {
      await tmux("new-session", "-d", "-s", relation, `exec /bin/bash --noprofile --norc ${shellQuote(launcher)}`);
      await tmux("wait-for", `${relation}-ready-tui`);
      const hook = `${relation}-attached`;
      await tmux("set-hook", "-g", "client-attached", `wait-for -S ${hook}`);
      const view = await workspaceCreate({ cwd: root, label: `ovis-test-tmux-app-server-${relation}` });
      remoteWorkspace = view.workspace.workspace_id;
      const paneId = view.root_pane.pane_id;
      await paneSendText(paneId, `exec env -u TMUX tmux -S ${shellQuote(socket)} attach-session -E -t ${relation}\n`);
      await tmux("wait-for", hook);
      const response = await fetch(`http://127.0.0.1:${port()}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
      expect(response.status).toBe(200);
      const conversation: ConversationResponse = await response.json();
      expect(conversation.source).toBe("codex-transcript");
      expect(JSON.stringify(conversation)).toContain("Only this native conversation belongs");
    } finally {
      try {
        if (remoteWorkspace !== undefined) await workspaceClose(remoteWorkspace);
      } finally { await tmux("kill-session", "-t", relation); }
    }
  }, 15_000);
}
