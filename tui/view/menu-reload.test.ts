import { expect, it } from "bun:test";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { startLoop } from "../loop.ts";
import { demo } from "../testing/fixtures/demo.ts";
import { HeadlessHost } from "../testing/headless-host.ts";
import { ManualClock } from "../testing/run.ts";

// The loop must perform Reload before interpreting the rest of the same read with the new keymap.
it.each(["joined", "split", "before first paint"])("Reload applies its new printable prefix before the following action: %s", async (ordering) => {
  const core = new FakeHcCore();
  demo.build(core);
  const host = new HeadlessHost({ cols: 120, rows: 80, answer: "\x1b[?1u\x1b[?2026;2$y\x1b[?62;22c" });
  const clock = new ManualClock();
  const loop = startLoop({
    host, clock, socket: "menu-reload.sock",
    keys: { prefix: "~", focus_pane_right: "prefix+r" },
    readKeys: () => ({ prefix: "!", focus_pane_right: "prefix+r" }),
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
    loop.dispatch({ type: "action", action: "detach", at: clock.current });
    expect(await loop.done).toMatchObject({ kind: "quit" });
    expect(clock.armed()).toBe(0);
  }
}, 60_000);
