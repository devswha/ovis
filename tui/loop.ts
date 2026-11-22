/**
 * Where the screen's modules meet: the host terminal, the input decoder, the core link, the pane machine, the state
 * core and the painter. The loop holds no rule of its own; it moves what one module answers to the module that acts
 * on it, in this order within a turn:
 *   1. host input -> the framer -> the reducer -> its effects, performed at once (typed bytes leave here, before any frame);
 *   2. when the one timer fires: whatever is due in the framer, the link, the panes, the model, a hold, a refused paste;
 *   3. a frame pass, at most every FRAME_PASS_MS: each shown pane's picture copied, ONE write, then credit (at most
 *      PASS_CREDIT_BYTES, the focused pane first, none when the write was not taken), then panes whose first paint was
 *      drawn go live after stdin was drained;
 *   4. the one timer armed again for the earliest deadline of all, or none.
 * Time and the timer are the caller's (`LoopClock`), so a test runs it on an injected clock.
 */

import type { HcTransport, HelloInfo } from "../server/herdr-core/connection.ts";
import { editLayout } from "../server/herdr-core/layout-ops.ts";
import { SeenMarker } from "../server/herdr-core/seen-label.ts";
import type { ScreenRange } from "./emulator/index.ts";
import { DividerWrites } from "./core/divider.ts";
import { LayoutWrites } from "./core/layout.ts";
import { type CoreLink, type LinkNotice, type LinkState, openLink } from "./core/link.ts";
import { createPanes, type PaneInput, type PaneNotice, type Panes, type PaneView } from "./core/pane.ts";
import { SeenWrites } from "./core/seen.ts";
import { CoreWorld } from "./core/world.ts";
import { errorCode } from "./crash.ts";
import { effectBytes, osc52 } from "./host/effects.ts";
import type { Host, HostEnd } from "./host/index.ts";
import type { InputEvent } from "./input/decode.ts";
import { Framer } from "./input/framer.ts";
import type { LoopEnd } from "./loop-end.ts";
import type { TuiThemeMode } from "./theme.generated.ts";
import { buildChrome, type PaneScroll, selectionColors, sessionFromSocket } from "./view/chrome.ts";
import { LINK_UNKNOWN, paneLive, shownLink, type ShownLink } from "./view/link-view.ts";
import { type Deadlines, earliest, FRAME_PASS_MS, HOLD_RELEASE_MS, PASS_CREDIT_BYTES, PASTE_ABANDON_MS, QUIT_BOUND_MS, STYLE_TABLE_LIMIT, CRASH_ACTIONS_KEPT } from "./model/deadlines.ts";
import type { Effect } from "./model/effects.ts";
import { focused } from "./model/focus.ts";
import { initialState, type ModelEvent, type ModelState, reduce } from "./model/reduce.ts";
import { PaneGrid } from "./view/grid.ts";
import { CopyView } from "./view/copy.ts";
import { type PaneLook, Pointer, type PointerAct, type PointerScene, rowsAboveBottom } from "./view/mouse.ts";
import { type HitMap, Painter, type PaneScene, type Scene } from "./view/paint.ts";
import { layOut, paneScene, type PaneSpot, type ScreenShape } from "./view/screen.ts";
import { ovisServer, type OvisServer } from "./core/ovis-server.ts";
import type { ViewStore } from "./view-store.ts";

/** The caller's clock and its one timer: `arm` sets the timer for `at` (on the same clock) and answers its cancel. */
export interface LoopClock {
  now(): number;
  arm(at: number, fire: () => void): () => void;
}

export interface LoopOptions {
  host: Host;
  clock: LoopClock;
  /** the core's socket, as the entry worked it out */
  socket: string;
  /** herdr's parsed `[keys]` table (anything else: the defaults) */
  keys: unknown;
  /** reads herdr's `[keys]` table again, for the reload action */
  readKeys?: () => unknown;
  /** one attempt at the socket: the real socket transport unless a test wraps it */
  connect?: (path: string) => Promise<HcTransport>;
  /** the hc session joined, shown in the header */
  session?: string;
  /** the folder the command was typed in: a new workspace starts there */
  cwd?: string;
  /** the user's home: a first workspace opened there is named `~`, as herdr's server names its own */
  home?: string;
  /** where the view is kept per core between runs; none: nothing is kept */
  views?: ViewStore;
  /** the Ovis server the launcher named, for herdr's New worktree and Delete worktree checkout...; none: they say to start it */
  server?: OvisServer;
}

export type { LoopEnd } from "./loop-end.ts";

/** What a test and the crash record read of a running loop. */
export interface LoopReport {
  /** the names due when the one armed timer fires (none: no timer) */
  due: string[];
  passes: number;
  /** frame writes handed to the host (an unchanged frame writes nothing) */
  writes: number;
  /** the last action codes: what happened, never what was typed or shown */
  actions: string[];
  hc: { version: string; features: string[] } | null;
  size: { cols: number; rows: number };
  mode: { name: string; locked: boolean; armed: boolean; overlays: string[]; notice?: NonNullable<ReturnType<CopyView["searchNotice"]>> };
  /** the stable code of the error giving the terminal back at quit failed with, or null */
  leaveError: string | null;
  /** the core link's state as data: what the chrome shows (Offline and its code, NoCore, Incompatible) */
  link: { kind: LinkState["kind"]; code: string | null };
}

export interface Loop {
  readonly done: Promise<LoopEnd>;
  report(): LoopReport;
  /** the state core's state now (tests read focus and notices) */
  model(): ModelState;
  /** An event from outside the host's input (a click turned into a `select`, a menu's `action`), through the state core now. */
  dispatch(event: ModelEvent): void;
  readonly panes: Panes;
  readonly link: CoreLink;
  /** the painter's composed screen: what the host shows once the last write was taken */
  screen(): Painter["screen"] | null;
}

export function startLoop(options: LoopOptions): Loop {
  const { host, clock } = options;
  const framer = new Framer(true);
  const world = new CoreWorld();
  const actions: string[] = [];
  const act = (code: string) => {
    actions.push(code);
    if (actions.length > CRASH_ACTIONS_KEPT) actions.shift();
  };

  let state = initialState(options.keys);
  let painter: Painter | null = null;
  /** the host answered DECRQM 2026 at start */
  let sync = false;
  let theme: TuiThemeMode = "dark";
  let shown: ShownLink = LINK_UNKNOWN;
  const session = options.session ?? sessionFromSocket(options.socket);
  let grids = new Map<string, { emulator: unknown; grid: PaneGrid }>();
  let shape: ScreenShape | null = null;
  const pointer = new Pointer();
  const copyView = new CopyView();
  /** the last frame's hit map and pane scenes: what the mouse lands on */
  let hits: HitMap | null = null;
  /** the model `hits` was made for: the last frame's, or the one `hitsNow` made them for since */
  let hitsOf: ModelState | null = null;
  const drawn = new Map<string, PaneScene>();
  /** the panes of the last frame the host took */
  let painted: ReadonlySet<string> = new Set();
  let shownKey = "";
  let paneFocus: string | null = null;
  let hello: HelloInfo | null = null;
  let entered = false;
  let ended = false;
  let quitting: { at: number; settle: () => void } | null = null;
  /** every channel is being closed (quit, hang-up, a signal): nothing is drawn again, whatever arrives meanwhile */
  let closing = false;
  let leaveError: string | null = null;
  let passOwed = false;
  let lastPass = -Infinity;
  let passes = 0;
  let writes = 0;
  let draining = false;
  const holds = new Map<string, number>();
  let pasteAt: number | null = null;
  let timer: { at: number; cancel: () => void } | null = null;
  let firstState: ((state: LinkState) => void) | null = null;

  let resolveDone!: (end: LoopEnd) => void;
  const done = new Promise<LoopEnd>((resolve) => { resolveDone = resolve; });

  /** Ends the loop once: no timer, no frame, no write after this. */
  const end = (how: LoopEnd) => {
    if (ended) return;
    ended = true;
    timer?.cancel();
    timer = null;
    act(`end:${how.kind}`);
    resolveDone(how);
  };

  const fail = (error: unknown) => {
    if (ended) return;
    act("crash");
    end({ kind: "crashed", error });
    void panes.close().catch(() => {});
    void link.close().catch(() => {});
  };

  /** Runs one piece of a turn; an error nothing expected ends the screen as a crash. */
  const guard = (work: () => void) => {
    if (ended && !quitting) return;
    try {
      work();
    } catch (error) {
      fail(error);
    }
  };

  const link = openLink({
    socket: options.socket,
    now: () => clock.now(),
    // the core model tells the marker each terminal's turn and labels, so a look another client wrote counts as written
    model: { ...world.model, observeSeen: (address, turn, labels) => marker.observe(address, turn, labels) },
    notify: (notice) => {
      guard(() => onLinkNotice(notice));
      arm();
    },
    ...(options.connect ? { connect: options.connect } : {}),
  });

  const marker = new SeenMarker(link);
  const seen = new SeenWrites(marker, (error) => act(`seen_failed:${errorCode(error)}`));

  const panes = createPanes({
    link,
    now: () => clock.now(),
    notify: (notice) => {
      guard(() => onPaneNotice(notice));
      arm();
    },
  });

  const dividers = new DividerWrites({
    edit: (change) => editLayout(link, change),
    refused: (refusal) => {
      guard(() => {
        dispatch({ type: "notice", code: refusal.code, data: refusal.reason === null ? {} : { reason: refusal.reason }, at: clock.now() });
        reshow();
        owePass();
      });
      arm();
    },
  });

  const layout = new LayoutWrites({
    hc: link,
    model: world.model,
    folder: options.cwd,
    home: options.home,
    refreshLayout: () => link.refreshLayout(),
    server: options.server ?? ovisServer(null),
    answer: (answer) => {
      guard(() => dispatch({ ...answer, at: clock.now() }));
      arm();
    },
  });

  function onLinkNotice(notice: LinkNotice): void {
    panes.notice(notice);
    if (notice.type === "state") {
      act(`link:${notice.state.kind}${"code" in notice.state ? `:${notice.state.code}` : ""}`);
      if (notice.state.kind !== "Connecting" && firstState) {
        const told = firstState;
        firstState = null;
        told(notice.state);
      }
      shown = shownLink(shown, notice.state);
      look();
      if (notice.state.kind === "Online") {
        const epoch = notice.state.epoch;
        void link.hello().then((info) => {
          if (link.state.kind === "Online" && link.state.epoch === epoch) {
            hello = info;
            world.setVersion(info.version);
            if (options.views) guard(() => dispatch({ type: "restore", ...options.views!.open(info.core.id), at: clock.now() }));
            guard(openFirstWorkspace);
            arm();
          }
        }, () => {});
      }
      owePass();
      return;
    }
    if (notice.type !== "event") {
      if (world.notice(notice)) worldChanged();
      readCore();
      return;
    }
    if (world.notice(notice)) worldChanged();
    if (notice.event.type === "turn" && notice.event.terminal !== undefined) seen.turn(notice.event.terminal);
    readCore();
  }

  function worldChanged(): void {
    dispatch({ type: "world", world: world.view().world, at: clock.now() });
    reshow();
  }

  /** a first workspace was asked for on this line's empty core: once a line */
  let firstAsked: number | null = null;

  /**
   * An empty core gets a first workspace, as herdr's server opens one when a client connects: checked once per line,
   * right after its hello, never on a core the app arranges. A core that empties later (its last workspace closed, or
   * the core shutting down) gets none.
   */
  function openFirstWorkspace(): void {
    const view = world.view();
    if (link.state.kind !== "Online" || hello === null || !view.ownsLayout || view.world.workspaces.length > 0 || firstAsked === link.state.epoch) return;
    firstAsked = link.state.epoch;
    act("open_first_workspace");
    void layout.openFirst();
  }

  /** The read of the core the world asks for, its answer handed back to it. */
  function readCore(): void {
    const read = world.nextRead();
    if (!read) return;
    const answered = (terminals: readonly unknown[] | null) => {
      guard(() => {
        if (world.answer(read, terminals)) worldChanged();
        readCore();
      });
      arm();
    };
    link.call(read.method, read.params).then((result) => answered(result.terminals), () => answered(null));
  }

  function onPaneNotice(notice: PaneNotice): void {
    if (copyView.changed(notice, panes)) dispatch({ type: "copy_closed", pane: notice.terminal });
    if (notice.type === "hold") {
      if (notice.held) holds.set(notice.terminal, clock.now());
      else holds.delete(notice.terminal);
    }
    if (notice.type === "gone") grids.delete(notice.terminal);
    if (notice.type === "state" || notice.type === "gone") shownAfterWrites.check();
    // a program that enters or leaves the alternate screen gives its pane's scrollbar gutter back or takes it again
    if (altScreens() !== altShown) reshow();
    if (notice.type === "effect" && !closing) {
      const bytes = effectBytes(notice.effect, notice.terminal === paneFocus);
      if (bytes && !host.write(bytes)) painter?.invalidate();
    }
    look();
    owePass();
  }

  /**
   * What the user typed, pasted or clicked while a layout write that one of their actions started is under way: it
   * waits behind that write, in order, and goes through once the write is done, so it meets the layout the write
   * leaves (the pane a close focuses, the pane a split follows), as a later read would. null when no write holds it.
   * `ahead` is the state core as if what waits had gone through: only to see a detach in it.
   */
  let behindWrite: { readonly events: ModelEvent[]; ahead: ModelState } | null = null;
  /**
   * When a detach among what waits leaves however far the wait got: the quit bound from the detach, so leaving takes no
   * longer than a detach typed with nothing ahead of it. What waited before it goes through first, in order, as the same
   * bytes read apart would; null when no detach waits.
   */
  let quitBy: number | null = null;

  /** A user's input event: through the state core now, or behind the layout write under way (a detach too, within its bound). */
  function userInput(event: ModelEvent): void {
    // nothing after a detach goes anywhere, from the same read either: the screen is leaving
    if (closing) return;
    const typed = event.type === "key" || event.type === "text" || event.type === "paste" || event.type === "mouse";
    // while a zoom that follows the focus is being written (or the panes it shows are drawing), what would reach a pane or
    // start another layout action waits for it in order, so it meets the pane the zoom shows and a layout that is free, as
    // a later read would; a further move goes on, so successive moves still coalesce. Never refused as busy: a command
    // waits as text does
    if (typed && behindWrite === null && shownAfterWrites.active() && waitsForWrites(event)) holdUntil(shownAfterWrites.settled());
    if (behindWrite === null || !typed) {
      const tab = focused(state.world, state.focus).tab?.id ?? null;
      dispatch(event);
      // input that showed another tab (a click in the sidebar or a menu): what follows it waits for that tab's pictures, as
      // the same input read later would meet them
      if (typed && (focused(state.world, state.focus).tab?.id ?? null) !== tab) shownAfterWrites.shown();
      return;
    }
    // read ahead the way the loop would go: the event, then each rest of a read it hands back, in order
    const ahead = [event];
    for (let next = ahead.shift(); next !== undefined; next = ahead.shift()) {
      const step = reduce(behindWrite.ahead, next);
      behindWrite.ahead = step.state;
      for (const effect of step.effects) {
        if (effect.type === "quit") quitBy ??= clock.now() + QUIT_BOUND_MS;
        if (effect.type === "input") ahead.push(effect.event);
      }
    }
    behindWrite.events.push(event);
  }

  /**
   * The layout writes the user's actions started, and a promise told once none is under way and the focused pane has its
   * picture (past opening and painting, not under a zoom): what was typed after an action meets the pane that action
   * leaves shown, at its own instant, as the same bytes read later would, however the reads fall. Active from such a write
   * until then.
   */
  const shownAfterWrites = {
    pending: 0,
    waiters: [] as (() => void)[],
    /** when the focused pane was found with its picture: what waited goes through at a later instant than it */
    readyAt: null as number | null,
    following: false,
    active(): boolean {
      return this.pending > 0 || this.following;
    },
    settled(): Promise<void> {
      return new Promise<void>((done) => {
        this.waiters.push(done);
        this.check();
      });
    },
    /** The user's input showed another tab: what follows waits until its panes have their pictures. */
    shown(): void {
      this.following = true;
      this.check();
    },
    started(writing: Promise<void>): void {
      this.pending++;
      this.following = true;
      void writing.finally(() => {
        this.pending--;
        guard(() => this.check());
        arm();
      });
    },
    check(): void {
      if (!this.following && this.waiters.length === 0) return;
      const pane = focused(state.world, state.focus).pane?.id ?? null;
      // every pane the layout now shows, the focused one first: input after the action may reach any of them (a move in
      // the same read), and one a zoom uncovered or a close enlarged attaches or paints again. A pane a zoom still covers
      // has not been shown yet: its picture comes once the layout uncovers it. A Live pane given a larger rectangle takes
      // it with the first input sent (the take resizes it), so it need not wait
      const shown = [pane, ...(shape?.spots ?? []).filter((spot) => !spot.covered).map((spot) => spot.pane)];
      const drawing = shown.some((terminal) => {
        const view = terminal === null ? undefined : panes.view(terminal);
        const kind = view?.state.kind;
        return kind === "Idle" || kind === "Opening" || kind === "Painting" || (terminal === pane && view?.covered === true);
      });
      if (this.pending > 0 || drawing) {
        this.readyAt = null;
        return;
      }
      // a pane refuses what was read at the instant it went live or before: the held input goes one tick later
      if (this.readyAt === null) this.readyAt = clock.now() + 1;
      if (clock.now() < this.readyAt) return;
      this.readyAt = null;
      this.following = false;
      for (const done of this.waiters.splice(0)) done();
    },
  };

  /**
   * Whether `event`, read now, must wait for the zoom-follow writes and the pictures they bring: what it does at once (through the pure state core)
   * sends something to a pane, takes the pointer, works copy mode on a pane, or starts a layout action other than a further move. The rest of a
   * read it hands back behind a move is not looked at here: it comes back through `userInput` and is weighed there, at
   * its own place in the input, as the same bytes read apart would be.
   */
  function waitsForWrites(event: ModelEvent): boolean {
    return reduce(state, event).effects.some((effect) => effect.type === "pane" || effect.type === "mouse" || effect.type === "copy" ||
      (effect.type === "run" && effect.action !== "zoom_follow"));
  }

  /**
   * Holds the user's input until `shown` (the layout written and the pictures of the panes it shows); then what waited goes
   * through in order (and may hold again), counted as read then: it was held for the picture of the pane it goes to, not
   * read before that picture (which a pane refuses as early).
   */
  function holdUntil(shown: Promise<void>): void {
    behindWrite ??= { events: [], ahead: state };
    void shown.then(() => {
      guard(() => {
        const waited = behindWrite?.events ?? [];
        behindWrite = null;
        const at = clock.now();
        for (const event of waited) userInput("at" in event ? { ...event, at } : event);
      });
      arm();
    });
  }

  /** What the screen shows now, told to the read state: a person looking at a pane marks its turn read. */
  function look(): void {
    const pane = focused(state.world, state.focus).pane?.id ?? null;
    seen.update({
      hostFocused: state.host.focused,
      pane,
      live: pane !== null && panes.view(pane)?.state.kind === "Live",
      drawn: pane !== null && painted.has(pane),
      overlay: state.overlays.length > 0,
      online: link.state.kind === "Online",
    });
  }

  /** One event through the state core, and its effects performed in order, now. */
  function dispatch(event: ModelEvent): void {
    const before = state;
    const step = reduce(state, event);
    state = step.state;
    for (const effect of step.effects) perform(effect);
    if (state !== before) {
      const unsaved = options.views?.keep(state) ?? null;
      if (unsaved !== null) dispatch({ type: "notice", code: "view_unsaved", data: { reason: unsaved }, at: clock.now() });
      reshow();
      look();
      owePass();
      shownAfterWrites.check();
    }
  }

  function perform(effect: Effect): void {
    switch (effect.type) {
      case "copy": {
        // a copy command reads the pane as it is now, not as the last frame drew it: what one read holds (a scroll, hint
        // mode, a label) acts as it does read apart, with a frame between each
        const spot = effect.command.kind === "leave" ? undefined : shape?.spots.find((spot) => spot.pane === effect.pane && !spot.covered);
        const shownScene = painter && spot ? sceneNow(painter.styles, spot) : drawn.get(effect.pane);
        const answer = copyView.run(effect, panes.view(effect.pane), shownScene && copyScene(shownScene));
        if (answer.text !== undefined) writeCopy(answer.text);
        if (answer.close) dispatch({ type: "copy_closed", pane: effect.pane });
        if (answer.unavailable) dispatch({ type: "notice", code: "copy_unavailable", at: clock.now() });
        owePass();
        return;
      }
      case "pane":
        for (const step of pointer.typed(effect.pane, lookOf(effect.pane))) performPointer(step);
        toPane(effect.pane, effect.input);
        rereadBranches();
        return;
      case "run": {
        act(`run:${effect.action}`);
        const writing = layout.run(effect);
        if (writing !== null) {
          // a zoom that follows the focus holds only what must wait for it (userInput): the next move goes on at once, and
          // the layout writes only the latest of such zooms. Any other action holds all input after it until it is written
          // and the pane it leaves focused is shown
          shownAfterWrites.started(writing);
          if (effect.action !== "zoom_follow") holdUntil(shownAfterWrites.settled());
          return;
        }
        // an action no module performs yet: one notice per press, never silence
        dispatch({ type: "notice", code: "not_built", data: { action: effect.action }, at: clock.now() });
        return;
      }
      case "input":
        // the rest of a text run, behind the action before it: it meets the focus and mode that action left
        userInput(effect.event);
        return;
      case "quit":
        act("quit");
        quit();
        return;
      case "clipboard":
        writeCopy(effect.text);
        return;
      case "reload_keys":
        act("reload_keys");
        dispatch({ type: "keys", keys: options.readKeys ? options.readKeys() : options.keys, at: clock.now() });
        return;
      case "mouse":
        act(`mouse:${effect.over}`);
        for (const step of pointer.mouse(effect.over, effect.event, pointerScene())) performPointer(step);
        return;
      case "host_reply":
        return;
    }
  }

  /** Input for a pane: each goes to the pane it names, in order (a prefix in a text run can move focus between two). */
  function toPane(pane: string, input: PaneInput): void {
    if (paneFocus !== pane) {
      paneFocus = pane;
      panes.focus(pane);
    }
    const sent = panes.input(input);
    act(`input:${input.type}:${sent.sent ? "sent" : sent.code}`);
    if (!sent.sent && sent.notice) dispatch({ type: "notice", code: "input_refused", data: { reason: sent.code }, at: clock.now() });
  }

  function performPointer(step: PointerAct): void {
    switch (step.kind) {
      case "select":
        dispatch({ type: "select", target: step.target, at: clock.now() });
        return;
      case "action":
        dispatch({ type: "action", action: step.action, at: clock.now() });
        return;
      case "forward":
        toPane(step.pane, step.event);
        return;
      case "scroll":
        // the emulator marks every row of its screen changed when the screen moves: the next pass draws them all
        panes.view(step.pane)?.emulator?.scrollFromBottom(step.fromBottom);
        owePass();
        return;
      case "copy":
        copy(step.pane, step.range);
        return;
      case "divider":
        act(`divider:${step.done ? "done" : "move"}`);
        dividers.move(step.grab, step.tab, step.name, step.ratio, step.done);
        reshow();
        owePass();
        return;
      case "redraw":
        owePass();
        return;
      case "close_overlay":
        dispatch({ type: "close_overlay", at: clock.now() });
        return;
      case "context":
        act(`context:${step.target.kind}`);
        dispatch({ type: "context", target: step.target, cell: step.cell, at: clock.now() });
        return;
      case "choose_heading":
        dispatch({ type: "key", key: "ENTER", mods: {}, action: "press", at: clock.now() } as ModelEvent);
        return;
      case "hover":
        dispatch({ type: "hover", entry: step.entry, ...(step.heading ? { heading: true } : {}), at: clock.now() });
        return;
      case "choose":
        dispatch({ type: "choose", entry: step.entry, at: clock.now() });
        return;
      case "button":
        dispatch(step.button === "accept"
          ? { type: "key", key: "ENTER", mods: {}, action: "press", at: clock.now() }
          : { type: "key", key: "c", mods: { ctrl: true }, action: "press", at: clock.now() });
        return;
    }
  }

  function copy(pane: string, range: ScreenRange): void {
    const text = panes.view(pane)?.emulator?.textOf(range);
    if (text?.ok) writeCopy(text.value);
  }

  function writeCopy(text: string): void {
    const data = new TextEncoder().encode(text);
    const write = osc52(data);
    if (!write.ok) {
      if (write.code !== "empty") dispatch({ type: "notice", code: "copy_refused", data: { reason: write.code, bytes: data.length }, at: clock.now() });
      return;
    }
    act("copy");
    // a write the host does not take means the terminal is gone: the screen ends, and no notice could be seen
    if (!host.write(write.bytes)) {
      painter?.invalidate();
      return;
    }
    dispatch({ type: "notice", code: "copied", data: { bytes: data.length }, calm: true, at: clock.now() });
  }

  /** What the pointer reads of a shown pane as the last frame drew it; null for a pane not drawn or with no picture. */
  function lookOf(pane: string, view: PaneView | undefined = panes.view(pane), scene: PaneScene | undefined = drawn.get(pane)): PaneLook | null {
    const emulator = view?.emulator;
    if (!emulator || !view.actual || !scene) return null;
    const modes = emulator.modes();
    const history = emulator.history();
    if (!modes.ok || !history.ok) return null;
    return { rect: scene.rect, top: scene.view?.row ?? 0, grid: view.actual, programMouse: modes.value.mouse !== "none", altScreen: modes.value.altScreen, emulator, history: history.value };
  }

  function pointerScene(): PointerScene {
    const tab = focused(state.world, state.focus).tab;
    const tree = tab ? dividers.shape(tab.id, world.view().tabs.get(tab.id)) : undefined;
    return {
      hits: hitsNow(), focus: paneFocus, tab: tab && tree ? { id: tab.id, root: tree.root } : null, splits: shape?.splits ?? [], look: (pane) => lookOf(pane),
      boxAt: (col, row) => shape?.spots.find(({ cells, covered }) => !covered && col >= cells.outer.x && col < cells.outer.x + cells.outer.width && row >= cells.outer.y && row < cells.outer.y + cells.outer.height)?.pane ?? null,
      passthrough: (pane) => focused(state.world, state.focus).tab?.passthrough?.includes(pane) ?? false,
      sidebarCollapsed: state.sidebarCollapsed,
      overlay: state.overlays.at(-1)?.kind ?? null,
    };
  }

  /**
   * A pane as copy mode sees it: without its last row while the mode bar lies over it, so the copy cursor, its hints and
   * its scrolling stay in the rows the user can see.
   */
  function copyScene(scene: PaneScene): PaneScene {
    const bar = shape?.regions.modeBar;
    const { rect } = scene;
    if (!bar || bar.height === 0 || rect.height < 2 || bar.y !== rect.y + rect.height - 1 || bar.x > rect.x || bar.x + bar.width < rect.x + rect.width) return scene;
    return { ...scene, rect: { ...rect, height: rect.height - 1 } };
  }

  /** whether a pane's program is on the alternate screen */
  function altScreen(pane: string): boolean {
    const modes = panes.view(pane)?.emulator?.modes();
    return modes?.ok === true && modes.value.altScreen;
  }

  /** the shown panes on the alternate screen, as the last layout counted them */
  let altShown = "";
  const altScreens = (): string => (shape?.spots ?? []).filter((spot) => altScreen(spot.pane)).map((spot) => spot.pane).join(" ");

  /** The shown tab's panes with their cells, told to the pane machine when anything about them changed. */
  function reshow(): void {
    const size = host.size();
    const view = world.view();
    const tab = focused(state.world, state.focus).tab;
    shape = layOut(size.cols, size.rows, tab ? dividers.shape(tab.id, view.tabs.get(tab.id)) ?? null : null, {
      sidebarCollapsed: state.sidebarCollapsed, gutter: (pane) => !altScreen(pane),
    });
    altShown = altScreens();
    const shown = shape.spots.map(({ pane, cells, covered }) => ({ terminal: pane, cols: cells.cols, rows: cells.rows, covered }));
    const key = JSON.stringify(shown);
    if (painter && key !== shownKey) {
      shownKey = key;
      panes.show(shown);
    }
    const pane = focused(state.world, state.focus).pane?.id ?? null;
    if (pane !== paneFocus) {
      paneFocus = pane;
      pointer.focusChanged(pane);
      panes.focus(pane);
      rereadBranches();
    }
  }

  /** A branch switched in a pane (a checkout typed there) shows at the next key or focus change: git's files read again. */
  function rereadBranches(): void {
    if (!world.rereadBranches()) return;
    worldChanged();
    owePass();
  }

  function owePass(): void {
    passOwed = true;
  }

  /** Bytes read from the host (or drained): events, each through the state core at once. */
  function read(bytes: Uint8Array): void {
    const events: InputEvent[] = framer.feed(bytes, clock.now());
    if (events.some((event) => event.type === "paste" && !event.complete)) pasteAt = clock.now() + PASTE_ABANDON_MS;
    else if (pasteAt !== null) pasteAt = events.length > 0 ? null : clock.now() + PASTE_ABANDON_MS;
    for (const event of events) {
      // the rest of a read that detached goes nowhere, as a later read would not
      if (closing) break;
      act(`read:${event.type}`);
      seen.input(event);
      if (event.type === "reply") {
        if (event.kind === "scheme") host.refreshDisplay();
        else panes.displayReply(event);
      }
      if (event.type === "focus") {
        panes.hostFocus(event.focused);
        // the host lost its screen meanwhile, or redrew it: the next frame writes every cell
        if (event.focused) painter?.invalidate();
      }
      userInput(event);
    }
  }

  /** Everything due by the clock, then a frame pass when one is owed and FRAME_PASS_MS passed since the last. */
  function turn(): void {
    const now = clock.now();
    if (closing) {
      if (quitting && now >= quitting.at) quitting.settle();
      return;
    }
    for (const event of framer.tick(now)) userInput(event);
    shownAfterWrites.check();
    // a detach that waited behind a write to its bound leaves now; what still waits goes nowhere
    if (quitBy !== null && behindWrite !== null && now >= quitBy) {
      behindWrite = null;
      perform({ type: "quit" });
      return;
    }
    if (pasteAt !== null && now >= pasteAt) {
      pasteAt = null;
      framer.reset();
      act("paste_reset");
    }
    link.fire();
    panes.fire();
    for (const [name, at] of state.deadlines) if (at <= now) dispatch({ type: "deadline", name, at: now });
    for (const [terminal, since] of holds) {
      if (since + HOLD_RELEASE_MS > now) continue;
      holds.delete(terminal);
      panes.view(terminal)?.emulator?.releaseHold();
      owePass();
    }
    if (passOwed && painter && now >= lastPass + FRAME_PASS_MS) pass(now);
  }

  /**
   * A shown pane as its emulator holds it now: its grid brought up to date (step 1 of a frame pass; the rows it copies stay
   * owed to the painter) and the scene that draws it, kept as the pane's drawn scene.
   */
  function sceneNow(styles: Painter["styles"], spot: PaneSpot, view: PaneView | undefined = panes.view(spot.pane)): PaneScene {
    const actual = view?.actual ?? { cols: spot.cells.cols, rows: spot.cells.rows };
    let held = grids.get(spot.pane);
    const emulator = view?.emulator ?? null;
    if (!held || held.emulator !== emulator) {
      held = { emulator, grid: new PaneGrid(styles, actual.cols, actual.rows) };
      grids.set(spot.pane, held);
    }
    held.grid.resize(actual.cols, actual.rows);
    if (emulator) held.grid.copy(emulator, held.grid.allDirty);
    const live = paneLive(view, shown);
    const scene = paneScene(spot, held.grid, actual, { live, hold: holds.has(spot.pane), dim: !live });
    drawn.set(spot.pane, scene);
    return scene;
  }

  /**
   * What a frame shows for the model as it is now: the panes' scenes (their grids brought up to date, the copied rows still
   * owed to the painter) and the chrome and overlays over them. `copied`: the panes whose emulator was copied in.
   */
  function compose(painter: Painter, shape: ScreenShape): Pick<Scene, "parts" | "panes" | "overlays" | "input" | "dim"> & { copied: Set<string> } {
    const scenes: PaneScene[] = [];
    let copying: ReturnType<CopyView["draw"]> = null;
    const copied = new Set<string>();
    const scroll = new Map<string, PaneScroll>();
    drawn.clear();
    for (const spot of shape.spots) {
      if (spot.covered) continue;
      const view = panes.view(spot.pane);
      const scene = sceneNow(painter.styles, spot, view);
      if (view?.emulator) copied.add(spot.pane);
      const look = lookOf(spot.pane, view, scene);
      if (look && look.history.total > look.grid.rows) scroll.set(spot.pane, { offset: rowsAboveBottom(look), max: look.history.total - look.grid.rows, viewport: look.grid.rows });
      const selection = pointer.shown(spot.pane, paneFocus, look);
      const copy = copyView.draw(copyScene(scene));
      if (copy) copying = copy;
      scenes.push({ ...(copy?.pane ?? scene), scrolledBack: look !== null && rowsAboveBottom(look) > 0, ...(!copy && selection ? { selection: { ...selection, colors: selectionColors(theme, host.colorDepth) } } : {}) });
    }
    const paneViews = new Map(panes.views().map((v) => [v.terminal, v]));
    const chrome = buildChrome({
      regions: shape.regions,
      spots: shape.spots,
      splits: shape.splits,
      state,
      world: world.view(),
      panes: paneViews,
      scroll,
      link: shown,
      session,
      theme,
      colors: host.colorDepth,
      copying,
      copyLook: copyView.look(),
    });
    return { parts: chrome.parts, panes: scenes, overlays: chrome.overlays, input: chrome.input, dim: chrome.dim, copied };
  }

  /**
   * The hit map for the model as it is now: the last frame's, unless input changed the model since (a menu opened, an entry
   * hovered), when the pointer meets what the next frame will show, however the reads fell.
   */
  function hitsNow(): HitMap | null {
    if (!painter || !shape || state === hitsOf) return hits;
    const size = host.size();
    hits = painter.hitMap({ width: size.cols, height: size.rows, ...compose(painter, shape) });
    hitsOf = state;
    return hits;
  }

  function pass(now: number): void {
    if (!painter || !shape || ended) return;
    passOwed = false;
    lastPass = now;
    passes++;
    // the style table only grows: past its limit the painter and every grid are made anew
    if (painter.styles.get(STYLE_TABLE_LIMIT) !== undefined) rebuildPainter();
    const size = host.size();
    const { copied, ...composed } = compose(painter, shape);
    const frame = painter.paint({ width: size.cols, height: size.rows, ...composed, focus: paneFocus });
    hits = frame.hits;
    hitsOf = state;
    let taken = true;
    if (frame.bytes.length > 0) {
      writes++;
      taken = host.write(frame.bytes);
    }
    painter.taken(taken);
    painted = taken ? new Set(drawn.keys()) : new Set();
    look();
    if (ended || !taken) return;
    // credit after the write was taken: the focused pane first, then the others (the pane machine credits a covered pane nothing)
    let budget = PASS_CREDIT_BYTES;
    const order = [...shape.spots].sort((a, b) => Number(b.pane === paneFocus) - Number(a.pane === paneFocus));
    for (const spot of order) {
      if (budget <= 0) break;
      budget -= panes.credit(spot.pane, budget);
    }
    // bytes a covered pane owes stay owed by design (it takes no credit until the zoom ends): they owe no pass
    if (order.some((spot) => { const view = panes.view(spot.pane); return view !== undefined && !view.covered && view.owed > 0; })) owePass();
    const ready = [...copied].filter((pane) => panes.view(pane)?.ready);
    if (ready.length > 0 && !draining) drainThenLive(ready);
  }

  /** What was typed before a pane's first paint was drawn is read (and refused there), then the pane is Live. */
  function drainThenLive(ready: string[]): void {
    draining = true;
    host.drain().then((bytes) => guard(() => {
      draining = false;
      if (bytes.length > 0) read(bytes);
      for (const pane of ready) if (panes.view(pane)?.ready) panes.live(pane);
      owePass();
      arm();
    }), fail);
  }

  function rebuildPainter(): void {
    if (!painter) return;
    painter = new Painter({ sync, colors: host.colorDepth });
    grids = new Map();
    act("painter_rebuilt");
  }

  /** Every deadline of every module, each under its own prefix, so two `failure` names stay apart. */
  function deadlines(): Deadlines {
    const all = new Map<string, number>();
    if (closing) return quitting ? all.set("quit", quitting.at) : all;
    const input = framer.deadline();
    if (input !== undefined) all.set("input", input);
    if (pasteAt !== null) all.set("paste", pasteAt);
    for (const [name, at] of link.deadlines()) all.set(`link:${name}`, at);
    for (const [name, at] of panes.deadlines()) all.set(`panes:${name}`, at);
    for (const [name, at] of state.deadlines) all.set(`model:${name}`, at);
    for (const since of holds.values()) all.set("hold", Math.min(all.get("hold") ?? Infinity, since + HOLD_RELEASE_MS));
    if (passOwed && painter) all.set("pass", Math.max(lastPass + FRAME_PASS_MS, clock.now()));
    if (shownAfterWrites.readyAt !== null) all.set("shown_release", shownAfterWrites.readyAt);
    if (quitBy !== null && behindWrite !== null) all.set("detach", quitBy);
    return all;
  }

  /** The one timer, for the earliest deadline; none when there is none. */
  function arm(): void {
    if (ended && !quitting) return;
    const first = earliest(deadlines());
    if (timer && first && timer.at === first.at) return;
    timer?.cancel();
    timer = null;
    if (!first) return;
    const at = first.at;
    timer = { at, cancel: clock.arm(at, () => {
      timer = null;
      guard(turn);
      arm();
    }) };
  }

  /** Closes every pane channel and the event stream, and settles when they are answered or QUIT_BOUND_MS passed. */
  function closeAll(): Promise<void> {
    act("close_all");
    closing = true;
    const closes = Promise.allSettled([panes.close(), link.close()]);
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        quitting = null;
        timer?.cancel();
        timer = null;
        resolve();
      };
      quitting = { at: quitBy ?? clock.now() + QUIT_BOUND_MS, settle };
      timer?.cancel();
      timer = null;
      arm();
      void closes.then(settle);
    });
  }

  function quit(): void {
    if (ended) return;
    void closeAll().then(() => {
      // the terminal is restored before the host throws a held write error: the quit stands, with the error's code
      try {
        host.leave();
      } catch (error) {
        leaveError = errorCode(error);
        act(`leave_failed:${leaveError}`);
      }
      end(leaveError === null ? { kind: "quit" } : { kind: "quit", leaveError });
    });
  }

  function onHostEnd(how: HostEnd): Promise<void> | void {
    if (ended) return;
    act(`host:${how.kind}`);
    // closeAll puts the loop in its closing state: no frame is drawn from here on
    return closeAll().then(() => {
      end(how.kind === "gone" ? { kind: "gone", why: how.why } : { kind: "signal" });
    });
  }

  async function start(): Promise<void> {
    const first = await new Promise<LinkState>((resolve) => {
      if (link.state.kind !== "Connecting") resolve(link.state);
      else firstState = resolve;
    });
    if (ended) return;
    if (first.kind === "NoCore" || first.kind === "Incompatible") {
      void link.close().catch(() => {});
      end(first.kind === "NoCore" ? { kind: "no_core", code: first.code } : { kind: "incompatible", code: first.code, reason: first.reason });
      return;
    }
    if (!host.enter()) {
      void link.close().catch(() => {});
      end({ kind: "not_a_terminal" });
      return;
    }
    entered = true;
    framer.setModes({ mouse: true });
    host.onInput((bytes) => {
      guard(() => read(bytes));
      arm();
    });
    host.onResize((size) => {
      guard(() => {
        act("resize");
        rebuildPainter();
        dispatch({ type: "resize", cols: size.cols, rows: size.rows, at: clock.now() });
        reshow();
        owePass();
      });
      arm();
    });
    host.onEnd((how) => onHostEnd(how));
    const size = host.size();
    guard(() => {
      dispatch({ type: "resize", cols: size.cols, rows: size.rows, at: clock.now() });
      reshow();
    });
    const probe = await host.probe();
    if (ended) return;
    guard(() => {
      framer.setModes({ kitty: (probe.kittyFlags ?? 0) > 0 });
      sync = probe.syncOutput === true;
      if (probe.theme === "light" || probe.theme === "dark") theme = probe.theme;
      panes.displayProbe(probe);
      host.watchDisplay();
      painter = new Painter({ sync, colors: host.colorDepth });
      reshow();
      owePass();
    });
    arm();
  }

  void start().catch(fail);

  return {
    done,
    panes,
    link,
    model: () => state,
    dispatch: (event) => {
      guard(() => dispatch(event));
      arm();
    },
    screen: () => painter?.screen ?? null,
    report: () => {
      const first = earliest(deadlines());
      const due = first ? [...deadlines()].filter(([, at]) => at === first.at).map(([name]) => name) : [];
      const notice = copyView.searchNotice();
      return {
        due: timer ? due : [],
        passes,
        writes,
        actions: [...actions],
        leaveError,
        hc: hello ? { version: hello.version, features: [...hello.features] } : null,
        size: entered ? host.size() : { cols: 0, rows: 0 },
        mode: { name: state.mode.name, locked: state.locked, armed: state.armed, overlays: state.overlays.map((overlay) => overlay.kind), ...(notice === null ? {} : { notice }) },
        link: { kind: link.state.kind, code: "code" in link.state ? link.state.code : null },
      };
    },
  };
}
