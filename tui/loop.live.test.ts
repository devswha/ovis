import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { coreFolder, IsolatedCore, type StopReport, stoppedCleanly } from "../scripts/test-hc.ts";
import { HcConnection } from "../server/herdr-core/connection.ts";
import { SPACE_LABEL, TAB_LABEL } from "../server/herdr-core/snapshot.ts";
import { connectCoreSocket } from "../server/herdr-core/socket-transport.ts";
import { gridText, runSupervised, stopAllPtyRuns, type SupervisedRun } from "./testing/pty.ts";

/**
 * The real entry (`bun tui/main.ts`) on a real pseudo-terminal against a real hc, in cores of the test's own: the
 * screen comes up and shows a shell's output, a typed command runs once, the detach key quits with one line and the
 * terminal cooked again, and the core and its terminal still run; started again it shows the same pane. Inside a pane
 * of its own core it refuses; inside another core's pane it runs. Signals at each stage give the terminal back. Runs
 * only where OVIS_TEST_HC_BIN names an hc.
 */
const bin = process.env["OVIS_TEST_HC_BIN"];
const ENTRY = join(import.meta.dir, "main.ts");
/** how long one step of the real screen and core may take on a pinned, loaded machine */
const WAIT_MS = 30_000;
/** above twice the helper's own 10 s wait for a stopped core, and the waits of every run */
const TEST_MS = 300_000;
const DETACH = "\x02q";
/** what the host writes when it gives the terminal back (tui/host/guard.ts LEAVE): exactly once per run */
const LEAVE = "\x1b[<u\x1b[?1006l\x1b[?1002l\x1b[?2004l\x1b[?1004l\x1b[?25h\x1b[?1049l";
/** what a terminal answers to the queries the screen's start probe ends with */
const ANSWERS: [query: string, answer: string][] = [["\x1b[c", "\x1b[?62;22c"], ["\x1b[?2026$p", "\x1b[?2026;2$y"]];

describe.skipIf(!bin || process.platform === "win32")("the screen's entry against a real hc", () => {
  const cores: IsolatedCore[] = [];
  const lines: HcConnection[] = [];
  let teardown: Promise<StopReport[]> | null = null;
  const stopAll = () => (teardown ??= (async () => {
    await stopAllPtyRuns();
    for (const line of lines) line.close();
    const reports: StopReport[] = [];
    for (const core of cores) reports.push(await core.stop());
    return reports;
  })());
  const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const onSignal = (signal: NodeJS.Signals) => { void stopAll().finally(() => process.exit(128 + constants.signals[signal])); };
  for (const signal of SIGNALS) process.once(signal, onSignal);

  afterAll(async () => {
    const reports = await stopAll();
    for (const signal of SIGNALS) process.off(signal, onSignal);
    expect(reports.map(stoppedCleanly)).toEqual(cores.map(() => true));
  }, TEST_MS);

  async function core(): Promise<{ core: IsolatedCore; hc: HcConnection; root: string }> {
    const folder = coreFolder();
    const started = new IsolatedCore(bin!, folder);
    cores.push(started);
    await started.start();
    const transport = await connectCoreSocket(started.socket);
    const hc = new HcConnection(() => transport);
    lines.push(hc);
    return { core: started, hc, root: folder.root };
  }

  /** The entry on a pty of its own, in the core's environment, answering the probe as a terminal does. */
  function screen(isolated: IsolatedCore, root: string): SupervisedRun {
    const env = { ...isolated.env, TERM: "xterm-256color", COLORTERM: "truecolor", OVIS_TUI_STATE_DIR: join(root, "tui-state"), TMPDIR: root };
    let tail = "";
    const run: SupervisedRun = runSupervised({
      entry: [process.execPath, ENTRY], env, cols: 100, rows: 30, deadlineMs: WAIT_MS * 4,
      onData: (text) => {
        const window = tail + text;
        // answered in the order asked, as a terminal does: DA1 comes last and ends the probe
        const asked: [at: number, answer: string][] = [];
        for (const [query, answer] of ANSWERS) {
          for (let at = window.indexOf(query); at !== -1; at = window.indexOf(query, at + 1)) if (at + query.length > tail.length) asked.push([at, answer]);
        }
        for (const [, answer] of asked.sort((a, b) => a[0] - b[0])) run.type(answer);
        tail = window.slice(-16);
      },
    });
    return run;
  }

  const labels = { [SPACE_LABEL]: "w-live", [TAB_LABEL]: "t-live" };

  it("comes up, runs a typed command once, detaches with one line, and leaves the core and its terminal running; again it shows the same pane", async () => {
    const { core: isolated, hc, root } = await core();
    const ran = join(root, "ran.log");
    const { address } = await hc.call("terminal.run", { argv: ["sh", "-c", "echo READY-MARK; exec sh"], labels, cwd: root });
    const first = screen(isolated, root);
    await first.until("READY-MARK", "the shell's output");
    // the cursor is shown only once the pane is Live (tui/view/paint.ts, step 6)
    await first.until(/READY-MARK[\s\S]*\x1b\[\?25h/, "the live pane's cursor");
    first.type(`echo typed-$((40+2)) >> ${ran}; echo done-$((1+1))\r`);
    await first.until("done-2", "the typed command's output");
    first.type(DETACH);
    const end = await first.ended;
    expect(end.code).toBe(0);
    expect(end.after?.canonical).toBe(true);
    expect(end.after?.echo).toBe(true);
    expect(first.output()).toContain("detached from herdr-core session");
    expect(first.output().split(LEAVE).length - 1).toBe(1);
    expect(readFileSync(ran, "utf8")).toBe("typed-42\n");
    const record = await hc.call("terminal.get", { terminal: address });
    expect(record.state).toBe("live");

    const again = screen(isolated, root);
    await again.until(/done-2[\s\S]*\x1b\[\?25h/, "the same pane, live again");
    again.type(DETACH);
    expect((await again.ended).code).toBe(0);
    expect(readFileSync(ran, "utf8")).toBe("typed-42\n");
    expect((await hc.call("terminal.get", { terminal: address })).state).toBe("live");
  }, TEST_MS);

  it("refuses inside its own core's pane, runs inside another core's", async () => {
    const own = await core();
    const other = await core();
    const report = (name: string) => join(own.root, name);
    const inPane = async (name: string, prefix: string) => {
      const line = `env | grep '^HC_' | sed 's/=.*//' > ${report(`${name}.env`)}; ${prefix} ${process.execPath} ${ENTRY} </dev/null 2> ${report(`${name}.err`)}; echo "exit=$?" >> ${report(`${name}.err`)}`;
      await own.hc.call("terminal.run", { argv: ["sh", "-c", line], labels, cwd: own.root, wait: true, timeout: WAIT_MS / 1000 });
      return readFileSync(report(`${name}.err`), "utf8");
    };
    const inside = await inPane("inside", "");
    expect(inside).toMatch(/^ovis tui: inside_own_core: .*\nexit=1\n$/);
    expect(readFileSync(report("inside.env"), "utf8").split("\n")).toContain("HC_TERMINAL_ID");
    const elsewhere = await inPane("elsewhere", `HC_SOCKET=${other.core.socket}`);
    expect(elsewhere).toMatch(/^ovis tui: not_a_terminal: .*\nexit=1\n$/);
  }, TEST_MS);

  it("gives the terminal back on SIGTERM, SIGINT and SIGHUP at every stage, and the terminal keeps running", async () => {
    const { core: isolated, hc, root } = await core();
    const { address } = await hc.call("terminal.run", { argv: ["sh", "-c", "echo READY-MARK; exec sh"], labels, cwd: root });
    const stages: [stage: string, signal: "SIGTERM" | "SIGINT" | "SIGHUP", reach: (run: SupervisedRun) => Promise<void>][] = [
      ["the start probe", "SIGTERM", async (run) => { await run.started; await run.until("\x1b[?1049h", "the screen's entry"); }],
      ["the first attach", "SIGINT", async (run) => { await run.until("\x1b[?1049h", "the screen's entry"); await run.until("\x1b[?25l", "the first frame"); }],
      ["a flood", "SIGHUP", async (run) => {
        await run.until(/READY-MARK[\s\S]*\x1b\[\?25h/, "the live pane");
        run.type("yes flood-line | head -n 200000\r");
        await run.until("flood-line", "the flood");
      }],
      // the flood scrolled READY-MARK away: a shown cursor alone says the pane is Live
      ["quit", "SIGTERM", async (run) => { await run.until(/\x1b\[\?1049h[\s\S]*\x1b\[\?25h/, "the live pane"); run.type(DETACH); }],
    ];
    const codes = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 } as const;
    for (const [stage, signal, reach] of stages) {
      const run = screen(isolated, root);
      await reach(run);
      run.signal(signal);
      const end = await run.ended;
      // a quit may finish before the signal lands
      expect([codes[signal], ...(stage === "quit" ? [0] : [])]).toContain(end.code);
      expect([stage, end.after?.canonical, end.after?.echo]).toEqual([stage, true, true]);
      expect([stage, run.output().split(LEAVE).length - 1]).toEqual([stage, 1]);
      expect((await hc.call("terminal.get", { terminal: address })).state).toBe("live");
    }
  }, TEST_MS);

  /** The screen's grid once more output arrived than now; the run's own deadline bounds the wait. */
  const nextGrid = async (run: SupervisedRun): Promise<string> => {
    await run.until(new RegExp(`^[\\s\\S]{${run.output().length + 1}}`), "more output");
    return gridText(run.output(), 100, 30);
  };

  it("shows a program named like an agent coming to the front as that agent, in its pane's title and the Agents list, with no reconnect", async () => {
    const { core: isolated, hc, root } = await core();
    mkdirSync(join(root, "bin"));
    // a shell every runner image has, under the agent's name; it stays in front until its read ends
    symlinkSync("/bin/sh", join(root, "bin", "claude"));
    await hc.call("terminal.run", { argv: ["sh", "-c", "echo FRONT-MARK; exec sh"], labels: { ...labels, "ovis.pane": "front-pane" }, cwd: root });
    const run = screen(isolated, root);
    await run.until(/FRONT-MARK[\s\S]*\x1b\[\?25h/, "the live pane");
    const before = await gridText(run.output(), 100, 30);
    expect([before.includes("[claude]"), before.includes("No agents")]).toEqual([false, true]);
    run.type(`exec ${join(root, "bin", "claude")} -c 'read line'\r`);
    await run.until("[claude]", "the agent in the pane's title");
    let grid = await gridText(run.output(), 100, 30);
    while (grid.includes("No agents")) grid = await nextGrid(run);
    expect(grid.split("\n").filter((line) => line.startsWith(" · front-pane /")).length).toBe(1);
    expect(grid.split("\n")[1]).toContain("front-pane");
    expect(grid.split("\n")[1]).toContain("[claude]");
    expect(run.output()).not.toContain("herdr-core is not answering");
    run.type(DETACH);
    expect((await run.ended).code).toBe(0);
  }, TEST_MS);

  it("keeps a pane whose program exited in its place with ended (code), until the core removes its terminal", async () => {
    const { core: isolated, hc, root } = await core();
    await hc.call("terminal.run", { argv: ["sh", "-c", "echo STAY-MARK; exec sh"], labels: { ...labels, "ovis.pane": "stays" }, cwd: root });
    const { address } = await hc.call("terminal.run", { argv: ["sh", "-c", "echo END-MARK; read line; exit 3"], labels: { ...labels, "ovis.pane": "ends" }, cwd: root });
    const run = screen(isolated, root);
    await run.until(/(?=[\s\S]*STAY-MARK)(?=[\s\S]*END-MARK)[\s\S]*\x1b\[\?25h/, "both panes live");
    await hc.call("terminal.send", { terminal: address, text: "go\r" });
    await run.until("ended (3)", "the ended pane's banner");
    // the banner can arrive in one read and the rest of its frame in the next
    const shown = (grid: string) => [grid.includes("+- stays "), grid.includes("+- ends "), grid.includes("+- ended (3) ")];
    let ended = await gridText(run.output(), 100, 30);
    while (shown(ended).includes(false)) ended = await nextGrid(run);
    expect(shown(ended)).toEqual([true, true, true]);
    expect((await hc.call("terminal.get", { terminal: address })).state).toBe("finished");
    await hc.call("terminal.rm", { terminal: address });
    let grid = ended;
    while (grid.includes("+- ends ")) grid = await nextGrid(run);
    expect([grid.includes("+- stays "), grid.includes("ended (3)")]).toEqual([true, false]);
    run.type(DETACH);
    expect((await run.ended).code).toBe(0);
  }, TEST_MS);

  it("draws the chrome (session header, sidebar, tabs, borders, mode bar, help overlay, notices) and the offline state on a real pty", async () => {
    const { core: isolated, hc, root } = await core();
    await hc.call("terminal.run", {
      argv: ["sh", "-c", "echo CHROME-LIVE-MARK; exec sh"],
      labels: { ...labels, "ovis.workspace": "live-ws", "ovis.tab": "live-tab", "ovis.pane": "live-pane" },
      cwd: root,
    });
    const run = screen(isolated, root);
    await run.until(/CHROME-LIVE-MARK[\s\S]*\x1b\[\?25h/, "the live pane and its chrome");
    expect(run.output()).toContain("Workspaces");
    expect(run.output()).toContain("Agents");
    expect(run.output()).toContain("live-ws");
    expect(run.output()).toContain("1:live-tab");
    expect(run.output()).toContain("live-pane");
    expect(run.output()).toContain("TERMINAL");

    // Armed prefix -> mode bar shows PREFIX, then '?' opens Keyboard Shortcuts help overlay, 'q' closes it
    run.type("\x02");
    await run.until("PREFIX", "the armed prefix mode bar");
    run.type("?");
    await run.until("Keyboard Shortcuts", "the help overlay");
    run.type("q");
    // Parity action prefix+s shows not_built notice
    run.type("\x02s");
    await run.until("not_built", "the parity action notice");

    // Stop the isolated core while the screen stays open -> screen draws the offline state with the command
    const stopped = await isolated.stop();
    expect(stoppedCleanly(stopped)).toBe(true);
    await run.until("herdr-core is not answering", "the offline banner");
    expect(run.output()).toContain("hc server start");

    run.type(DETACH);
    const end = await run.ended;
    expect(end.code).toBe(0);
    expect(end.after?.canonical).toBe(true);
    expect(end.after?.echo).toBe(true);
  }, TEST_MS);
});
