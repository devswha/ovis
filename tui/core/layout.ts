/**
 * The screen's layout writes: herdr's create, close, rename, split, zoom, resize, swap, move and reorder actions, and a
 * tab's zoom following the focus to a pane it covered,
 * performed through the shared layout operations the server performs the browser's with (server/herdr-core/layout-ops.ts).
 * Every rule of the layout lives there; this module holds only the screen's policy on top:
 * - one write in flight: ordinary actions chosen while one is under way are refused; the model coalesces focus moves;
 * - nothing is sent again: an answer that never came (the line ended, a timeout) is reported as unknown, and the
 *   world shows what the core holds once the line is back;
 * - nothing is drawn ahead: the picture changes only when the core's documents and terminals say so;
 * - a close ends only the terminals the user saw: their addresses and created_ms are read again first.
 */

import type { HcConnection } from "../../server/herdr-core/connection.ts";
import { HcError } from "../../server/herdr-core/connection.ts";
import { AdapterError } from "../../server/herdr-core/errors.ts";
import { foreignLayout, leaves, OVIS_LAYOUT_DOC, OVIS_LAYOUT_SCHEMA, type PaneDirection, type SplitDirection } from "../../server/herdr-core/layout-doc.ts";
import { type CloseTarget, layoutCalls, LayoutStore, type LayoutView, newLayoutId, ownsLayout, readCore, RESIZE_STEP, resizeEdit, swapEdit, TERMINAL_COLOUR, zoomEdit } from "../../server/herdr-core/layout-ops.ts";
import { type CoreHost, type FirstTurn, LAYOUT_DOC, OTHER_WORKSPACE_ID } from "../../server/herdr-core/snapshot.ts";
import { errorCode } from "../crash.ts";
import type { RunEffect, Seen } from "../model/effects.ts";
import type { Target } from "../model/focus.ts";

/** What a layout write tells the screen: a notice (`calm` when it reports how things are, not a failure), or a pane to focus once shown. */
export type LayoutAnswer =
  | { readonly type: "notice"; readonly code: string; readonly data: Readonly<Record<string, string>>; readonly calm?: true }
  | { readonly type: "follow"; readonly target: Target; readonly away: string | null }
  | { readonly type: "zoom_settled"; readonly current: boolean };

interface LayoutWritesOptions {
  /** the core's line (the screen's link) */
  hc: Pick<HcConnection, "call" | "hello">;
  /** how the screen reads terminals into the snapshot, the same as its world (world.ts `CoreWorld.model`) */
  model: { readonly firstTurn: FirstTurn; readonly host: CoreHost };
  /** the folder the screen was opened in: a new workspace starts there */
  folder: string | undefined;
  /** Publish the authoritative document before the model settles a zoom intent. */
  refreshLayout: () => Promise<boolean>;
  answer: (answer: LayoutAnswer) => void;
}

/** What herdr names the first workspace its server opens in its own home. */
const HOME_NAME = "~";

/** The layout document's key for the first workspace's claim (`LayoutWrites.claimFirst`). */
const FIRST_CLAIM = "first_workspace";
/** The claim a screen writes while it opens the first workspace; the document holds it for no longer. */
const OPENING = { opening: true } as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const SPLITS: Readonly<Record<string, SplitDirection>> = { split_vertical: "right", split_horizontal: "down" };
const SWAPS: Readonly<Record<string, PaneDirection>> = { swap_pane_left: "left", swap_pane_down: "down", swap_pane_up: "up", swap_pane_right: "right" };
const RESIZES: Readonly<Record<string, PaneDirection>> = { resize_pane_left: "left", resize_pane_down: "down", resize_pane_up: "up", resize_pane_right: "right" };

function unknownWrite(error: unknown): boolean {
  return error instanceof HcError && (error.kind === "closed" || error.kind === "offline" || error.kind === "timeout");
}

/** The core read afresh: the snapshot as the screen shows it, when the core made each terminal, and those whose program already ended. */
interface Fresh { readonly view: LayoutView; readonly created: ReadonlyMap<string, number> }

/** Whether the terminals a close ends now are exactly the ones the user saw, each made at the time it was shown. */
function sameTerminals(ends: readonly string[], seen: readonly Seen[], created: ReadonlyMap<string, number>): boolean {
  if (ends.length !== seen.length) return false;
  const now = new Set(ends);
  return seen.every((one) => now.has(one.id) && (one.created === null || created.get(one.id) === one.created));
}

/** The place `id` moves to among `ids`, as herdr's insertion boundary: one up or one down; null at that end. */
function oneStep(ids: readonly string[], id: string, down: boolean): number | null {
  const at = ids.indexOf(id);
  if (at < 0 || (down ? at === ids.length - 1 : at === 0)) return null;
  return down ? at + 2 : at - 1;
}

export class LayoutWrites {
  private readonly store: LayoutStore;
  private busy = false;

  constructor(private readonly options: LayoutWritesOptions) {
    const { hc } = options;
    this.store = new LayoutStore(hc, {
      snapshot: async () => (await this.fresh()).view,
      newId: newLayoutId,
      terminal: async (address) => {
        const found = await hc.call("terminal.get", { terminal: address });
        if (found.state !== "live") throw new AdapterError("pane_not_found", `terminal ${address} has finished`);
        return found;
      },
      terminalEnv: async () => ({ ...TERMINAL_COLOUR }),
    });
  }

  /**
   * Opens a first workspace on a core that has none, as herdr's server does: a shell in the core's own folder (its home),
   * not the screen's. Every screen on the core, and the browser, share it, so the create is guarded by a claim in the
   * layout document taken by compare-and-set (`claimFirst`): of the screens that find the core empty at once, one
   * creates. Answers when it is done; a failure is a notice.
   */
  openFirst(): Promise<void> {
    if (this.busy) return Promise.resolve();
    this.busy = true;
    return this.perform("new_workspace", () => this.claimFirst());
  }

  /**
   * The first workspace's claim. The claim is a key of the layout document beside its workspaces; every reader keeps
   * only the schema and the workspaces (snapshot.ts `keptLayout`), so no reader sees it and the next layout edit drops
   * it. Steps:
   * 1. read the document, then the terminals: nothing to do unless the core has no terminal, Ovis arranges its layout and
   *    no claim is in the document;
   * 2. write the claim with the version read: a screen that loses the race gets a conflict and stops;
   * 3. read the terminals again: another client may have opened one meanwhile, then the claim is let go;
   * 4. create the workspace, then take the claim out of the document: a screen that reads the document after that finds
   *    the workspace's terminal, and the document is left as the browser and every reader know it.
   * A screen that dies between 2 and 4 leaves the claim until the next layout edit drops it: the core then stays empty,
   * and the sidebar's new button still opens a workspace.
   */
  private async claimFirst(): Promise<void> {
    const { hc } = this.options;
    if (!layoutCalls(await hc.hello())) return;
    const doc = await hc.call("doc.get", { name: OVIS_LAYOUT_DOC });
    const [list, app] = await Promise.all([hc.call("terminal.list", {}), hc.call("doc.get", { name: LAYOUT_DOC })]);
    if (!ownsLayout(app.value) || foreignLayout(doc.value) || list.terminals.length > 0) return;
    if (isRecord(doc.value) && doc.value[FIRST_CLAIM] !== undefined) return;
    const layout = isRecord(doc.value) ? doc.value : { schema: OVIS_LAYOUT_SCHEMA, workspaces: [] };
    const write = async (claim: boolean, version: number): Promise<number | null> => {
      const { [FIRST_CLAIM]: _old, ...rest } = layout;
      try {
        return (await hc.call("doc.set", { name: OVIS_LAYOUT_DOC, value: claim ? { ...rest, [FIRST_CLAIM]: OPENING } : rest, version })).version;
      } catch (error) {
        if (error instanceof HcError && error.kind === "conflict") return null;
        throw error;
      }
    };
    const claimed = await write(true, doc.version);
    if (claimed === null) return;
    if ((await hc.call("terminal.list", {})).terminals.length > 0) {
      await write(false, claimed);
      return;
    }
    let address: string;
    try {
      address = (await this.store.createWorkspace({ name: HOME_NAME })).root_pane.pane_id;
    } catch (error) {
      await write(false, claimed);
      throw error;
    }
    await write(false, claimed);
    this.follow(address, null);
  }

  /**
   * Performs `effect` when it is a layout action and answers when it is done (it never rejects: a failure is a notice);
   * null for any other action.
   */
  run(effect: RunEffect): Promise<void> | null {
    const work = this.work(effect);
    if (work === null) return null;
    if (this.busy) {
      this.notice("layout_busy", { action: effect.action });
      if (effect.action === "zoom_follow") this.options.answer({ type: "zoom_settled", current: false });
      return Promise.resolve();
    }
    this.busy = true;
    return this.perform(effect.action, work);
  }

  private async perform(action: string, work: () => Promise<void>): Promise<void> {
    let current = false;
    try {
      let known = true;
      try {
        await work();
      } catch (error: unknown) {
        known = !unknownWrite(error);
        await this.refused(action, error);
      }
      if (action === "zoom_follow" && known) current = await this.options.refreshLayout();
    } finally {
      this.busy = false;
      if (action === "zoom_follow") this.options.answer({ type: "zoom_settled", current });
    }
  }

  private work(effect: RunEffect): (() => Promise<void>) | null {
    const { action, target } = effect;
    const id = target?.id;
    const store = this.store;
    if (action === "new_workspace") {
      return async () => this.follow((await store.createWorkspace(this.options.folder === undefined ? {} : { cwd: this.options.folder })).root_pane.pane_id, null);
    }
    if (id === undefined) return null;
    if (action === "new_tab") return async () => this.follow((await store.createTab(id, effect.name ? { name: effect.name } : {})).root_pane.pane_id, null);
    if (Object.hasOwn(SPLITS, action)) return async () => this.follow((await store.split(id, SPLITS[action]!)).pane_id, null);
    if (action === "close_pane" || action === "close_tab" || action === "close_workspace") {
      const close: CloseTarget = action === "close_pane" ? { pane: id } : action === "close_tab" ? { tab: id } : { workspace: id, group: false };
      return () => this.close(action, close, effect.seen ?? []);
    }
    if (action === "rename_workspace") return () => store.rename({ workspace: id, name: effect.name ?? "" });
    if (action === "rename_tab") return () => store.rename({ tab: id, name: effect.name ?? "" });
    if (action === "rename_pane") return () => store.rename({ pane: id, name: effect.name || null });
    if (action === "zoom") return async () => this.unchanged(action, await store.edit(zoomEdit(id, "toggle")));
    if (action === "zoom_follow" && effect.zoomTab !== undefined) {
      return async () => {
        await store.edit((layout) => {
          const tab = layout.workspaces.flatMap((workspace) => workspace.tabs).find((candidate) => candidate.id === effect.zoomTab);
          // A different writer may have unzoomed this tab or moved the target while the intent waited.
          return tab && tab.zoomed !== null && leaves(tab.root).includes(id)
            ? zoomEdit(id, "on")(layout)
            : { layout: null, reason: "stale" };
        });
      };
    }
    if (Object.hasOwn(SWAPS, action)) return async () => this.unchanged(action, await store.edit(swapEdit(id, null, SWAPS[action]!)));
    if (Object.hasOwn(RESIZES, action)) return async () => this.unchanged(action, await store.edit(resizeEdit(id, RESIZES[action]!, RESIZE_STEP)));
    if (action === "move_tab_previous" || action === "move_tab_next") {
      return async () => {
        const { shown } = (await this.fresh()).view;
        const workspace = shown.tabs.find((tab) => tab.tab_id === id)?.workspace_id;
        const to = oneStep(shown.tabs.filter((tab) => tab.workspace_id === workspace).map((tab) => tab.tab_id), id, action === "move_tab_next");
        if (to === null) this.unchanged(action, { changed: false, reason: action === "move_tab_next" ? "last" : "first" });
        else this.unchanged(action, await store.moveTab(id, to));
      };
    }
    if (action === "navigate_move_up" || action === "navigate_move_down") {
      return async () => {
        const { shown } = (await this.fresh()).view;
        const to = oneStep(shown.workspaces.map((workspace) => workspace.workspace_id).filter((one) => one !== OTHER_WORKSPACE_ID), id, action === "navigate_move_down");
        if (to === null) this.unchanged(action, { changed: false, reason: action === "navigate_move_down" ? "last" : "first" });
        else this.unchanged(action, await store.moveWorkspace(id, to));
      };
    }
    if (action === "navigate_move_pane" && effect.to !== undefined) {
      const to = effect.to;
      return async () => this.follow(id, (await store.moveToNewTab(id, to, effect.name ?? "")).tab_id);
    }
    return null;
  }

  /** The core as the screen shows it, read now (the same terminals its world shows: no finished one), with each terminal's created_ms. */
  private async fresh(): Promise<Fresh> {
    const { terminals, ...view } = await readCore(this.options.hc, { ...this.options.model, all: true });
    return {
      view,
      created: new Map(terminals.map((terminal) => [terminal.address, terminal.created_ms])),
    };
  }

  /** A close, once the core still holds exactly the terminals the user saw: it ends those and no other; anything else ends nothing. */
  private async close(action: string, target: CloseTarget, seen: readonly Seen[]): Promise<void> {
    const { view, created } = await this.fresh();
    const ends = this.store.endsOf(view.shown, target);
    if (!sameTerminals(ends, seen, created)) {
      this.notice("target_changed", { action });
      return;
    }
    await this.store.end(ends);
  }

  private follow(pane: string, away: string | null): void {
    this.options.answer({ type: "follow", target: { kind: "pane", id: pane }, away });
  }

  private notice(code: string, data: Readonly<Record<string, string>>, calm = false): void {
    this.options.answer({ type: "notice", code, data, ...(calm || data.action === "zoom_follow" ? { calm: true } : {}) });
  }

  /** An edit that changed nothing says why, calmly: the precondition was gone on the document as it is now. */
  private unchanged(action: string, answer: { changed: boolean; reason: string | null }): void {
    if (!answer.changed) this.notice("layout_unchanged", { action, reason: answer.reason ?? "unchanged" }, true);
  }

  /** One notice per failed action, by its stable code. */
  private async refused(action: string, error: unknown): Promise<void> {
    if (error instanceof AdapterError) {
      if (error.code === "unsupported") this.notice(...await this.unsupported(action));
      else if (error.code === "layout_not_saved") this.notice("layout_not_saved", { action });
      else this.notice("layout_refused", { action, reason: error.code });
      return;
    }
    if (error instanceof HcError && error.kind === "conflict") this.notice("layout_conflict", { action }, true);
    // the line ended or the answer never came: what happened is unknown, and nothing is sent again
    else if (unknownWrite(error)) this.notice("layout_unknown", { action });
    else this.notice("layout_refused", { action, reason: errorCode(error) });
  }

  /** Why the store refused: the Herdr app arranges the core, a newer Ovis wrote the layout, or the core keeps no documents. */
  private async unsupported(action: string): Promise<[string, Record<string, string>]> {
    const { hc } = this.options;
    try {
      const [app, ovis, hello] = await Promise.all([hc.call("doc.get", { name: LAYOUT_DOC }), hc.call("doc.get", { name: OVIS_LAYOUT_DOC }), hc.hello()]);
      if (!ownsLayout(app.value)) return ["app_owned", { action }];
      if (!layoutCalls(hello)) return ["layout_refused", { action, reason: "no_documents" }];
      if (foreignLayout(ovis.value)) return ["layout_refused", { action, reason: "foreign_layout" }];
    } catch {
      // the reads failed too: the store's own answer stands
    }
    return ["layout_refused", { action, reason: "unsupported" }];
  }
}
