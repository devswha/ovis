import { expect, it } from "bun:test";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { startLoop } from "../loop.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { HeadlessHost } from "../testing/headless-host.ts";
import { ManualClock } from "../testing/run.ts";

// The loop must perform Reload before interpreting the rest of the same read with the new keymap.
it.each(["joined", "split", "before first paint", "held joined", "held split", "held shortcut joined", "held shortcut split", "held click"])("Reload applies its new printable prefix before the following action: %s", async (ordering) => {
  const core = new FakeHcCore();
  demo.build(core);
  const host = new HeadlessHost({ cols: 120, rows: 80, answer: "\x1b[?1u\x1b[?2026;2$y\x1b[?62;22c" });
  const clock = new ManualClock();
  const answer = Promise.withResolvers<void>();
  let reads = 0;
  const loop = startLoop({
    host, clock, socket: "menu-reload.sock",
    keys: { prefix: "~", focus_pane_right: "prefix+r" },
    // A second file read would restore the old prefix: replay must use the first resolved map.
    readKeys: () => ({ prefix: ++reads === 1 ? "!" : "~", focus_pane_right: "prefix+r" }),
    connect: async () => core.transport(),
  });
  // Drive the real loop and host clocks until an observable condition, with a bounded simulated deadline.
  const until = async (ready: () => boolean) => {
    const deadline = clock.current + 5_000;
    while (!ready() && clock.current < deadline) {
      clock.current += 1;
      host.advance(1);
      clock.fireDue();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(ready()).toBe(true);
  };
  try {
    await until(() => loop.panes.views().length === 2 && loop.panes.views().every((view) => view.state.kind === "Live"));
    clock.current += 1;
    host.advance(1);
    host.feed("~\r");
    const menu = loop.model().overlays.at(-1);
    if (menu?.kind !== "menu") throw new Error("menu did not open");
    const reload = menu.entries.find((entry) => entry.kind === "action" && entry.action === "reload_config");
    if (!reload?.label) throw new Error("Reload has no menu label");
    if (ordering.startsWith("held")) {
      host.feed("\x1b[27u");
      const written = Promise.withResolvers<void>();
      const call = loop.link.call.bind(loop.link);
      loop.link.call = async (method, params, timeout) => {
        if (method === "terminal.label") {
          loop.link.call = call;
          const result = await call(method, params, timeout);
          written.resolve();
          await answer.promise;
          return result;
        }
        return call(method, params, timeout);
      };
      host.feed("~Prenamed\r");
      await written.promise;
      if (ordering === "held click") {
        await until(() => loop.model().world.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes))
          .some((pane) => pane.id === "t1" && pane.name === "renamed"));
        loop.dispatch({ type: "action", action: "menu", at: clock.current });
        await until(() => loop.screen()?.text.join("").includes(`${reload.label} reload`) === true);
        const screen = loop.screen()!;
        const label = `${reload.label} reload`;
        const at = screen.text.findIndex((_, index) => screen.text.slice(index, index + label.length).join("") === label);
        expect(at).toBeGreaterThanOrEqual(0);
        const row = Math.floor(at / screen.cols);
        const col = at % screen.cols;
        host.feed(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`);
        expect(reads).toBe(0);
      } else {
        const shortcut = ordering.includes("shortcut");
        if (!shortcut) host.feed("~\r");
        const trigger = shortcut ? "~R" : reload.label;
        if (ordering.endsWith("split")) {
          host.feed(trigger);
          host.feed("~q");
        } else host.feed(`${trigger}~q`);
      }
      expect(loop.report().actions).not.toContain("quit");
      answer.resolve();
      if (ordering === "held click") {
        await until(() => loop.model().overlays.length === 0);
        expect(reads).toBe(1);
        host.feed("~q");
      }
      await until(() => core.program("t1").receivedHex() !== "" || loop.report().actions.includes("quit"));
      expect(loop.report().actions).not.toContain("quit");
      expect(["t1", "t2"].map((id) => core.program(id).receivedHex())).toEqual(["7e71", ""]);
      expect(reads).toBe(1);
      return;
    }
    if (ordering !== "before first paint") {
      await until(() => loop.screen()?.text.join("").includes("+ Menu ") === true);
    }
    if (ordering === "split") {
      host.feed(reload.label);
      host.feed("!rz");
    } else host.feed(`${reload.label}!rz`);
    // A protocol barrier makes preceding input observable without waiting for a guessed duration.
    await loop.link.call("machine.list", {});
    expect({
      actions: loop.report().actions.filter((action) => action === "reload_keys" || action.startsWith("run:")),
      bytes: ["t1", "t2"].map((id) => core.program(id).receivedHex()),
    }).toEqual({ actions: ["reload_keys", "run:focus_pane_right"], bytes: ["", "7a"] });
    expect(loop.report().mode.overlays).toEqual([]);
  } finally {
    answer.resolve();
    loop.dispatch({ type: "action", action: "detach", at: clock.current });
    expect(await loop.done).toMatchObject({ kind: "quit" });
    expect(clock.armed()).toBe(0);
  }
}, 60_000);
