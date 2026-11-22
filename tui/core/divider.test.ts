import { describe, expect, it } from "bun:test";
import type { LayoutNode, OvisLayout } from "../../server/herdr-core/layout-doc.ts";
import type { Edited } from "../../server/herdr-core/layout-ops.ts";
import { type DividerRefusal, dividerAt, dividerEdit, dividerPath, DividerWrites } from "./divider.ts";

const leaf = (id: string): LayoutNode => ({ leaf: id });
const right = (first: LayoutNode, second: LayoutNode, ratio = 0.5): LayoutNode => ({ split: "right", ratio, first, second });
const down = (first: LayoutNode, second: LayoutNode, ratio = 0.5): LayoutNode => ({ split: "down", ratio, first, second });

/** a | (b over c): the root divider between a and b, the inner one between b and c */
const TREE = right(leaf("a"), down(leaf("b"), leaf("c")));
const layoutOf = (root: LayoutNode): OvisLayout => ({ schema: 1, workspaces: [{ id: "w", tabs: [{ id: "t", root, zoomed: null }] }] });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("a divider named by its two sides", () => {
  it("is named by the first pane of each side and found again by that name", () => {
    expect(dividerAt(TREE, [])).toEqual({ first: "a", second: "b", direction: "right" });
    expect(dividerAt(TREE, [true])).toEqual({ first: "b", second: "c", direction: "down" });
    expect(dividerAt(TREE, [false])).toBeNull();
    expect(dividerAt(TREE, [true, true])).toBeNull();
    expect(dividerPath(TREE, { first: "a", second: "b", direction: "right" })).toEqual([]);
    expect(dividerPath(TREE, { first: "b", second: "c", direction: "down" })).toEqual([true]);
  });

  it("is found where someone else's edit moved it, and not where it is gone or turned", () => {
    // another split wrapped the whole tree: the same divider, one level down
    const wrapped = down(TREE, leaf("d"));
    expect(dividerPath(wrapped, { first: "b", second: "c", direction: "down" })).toEqual([false, true]);
    // c was closed: the split between b and c is gone
    expect(dividerPath(right(leaf("a"), leaf("b")), { first: "b", second: "c", direction: "down" })).toBeNull();
    // the split was turned
    expect(dividerPath(down(leaf("a"), leaf("b")), { first: "a", second: "b", direction: "right" })).toBeNull();
    // the two sides changed places
    expect(dividerPath(right(leaf("b"), leaf("a")), { first: "a", second: "b", direction: "right" })).toBeNull();
  });

  it("its edit sets the ratio where the name is found, in any tab, and answers stale where it is not", () => {
    const set = dividerEdit({ first: "b", second: "c", direction: "down" }, 0.25)(layoutOf(TREE));
    expect(set.reason).toBeNull();
    expect(set.layout?.workspaces[0]!.tabs[0]!.root).toEqual(right(leaf("a"), down(leaf("b"), leaf("c"), 0.25)));
    expect(dividerEdit({ first: "b", second: "a", direction: "right" }, 0.25)(layoutOf(TREE))).toEqual({ layout: null, reason: "stale" });
  });
});

/** An edit held until the test answers it: the changes asked for, in order. */
function heldEdits() {
  const asked: { change: (layout: OvisLayout) => Edited; answer: (reason: string | null) => void; fail: (error: unknown) => void }[] = [];
  const edit = (change: (layout: OvisLayout) => Edited) => new Promise<{ changed: boolean; reason: string | null }>((resolve, reject) => {
    asked.push({ change, answer: (reason) => resolve({ changed: reason === null, reason }), fail: reject });
  });
  return { asked, edit };
}

const NAME = { first: "a", second: "b", direction: "right" } as const;
const ratioWritten = (change: (layout: OvisLayout) => Edited): number | null => {
  const root = change(layoutOf(right(leaf("a"), leaf("b")))).layout?.workspaces[0]!.tabs[0]!.root;
  return root && "ratio" in root ? root.ratio : null;
};

describe("a divider drag's writes", () => {
  it("one write in flight, the newest ratio kept for the next, nothing more once it landed", async () => {
    const { asked, edit } = heldEdits();
    const writes = new DividerWrites({ edit, refused: () => {} });
    writes.move(1, "t", NAME, 0.3, false);
    writes.move(1, "t", NAME, 0.4, false);
    writes.move(1, "t", NAME, 0.6, false);
    expect(asked.map((one) => ratioWritten(one.change))).toEqual([0.3]);
    asked[0]!.answer(null);
    await turn();
    expect(asked.map((one) => ratioWritten(one.change))).toEqual([0.3, 0.6]);
    writes.move(1, "t", NAME, 0.6, true);
    asked[1]!.answer(null);
    await turn();
    expect(asked.length).toBe(2);
  });

  it("a second divider dragged while the first one's write is held waits for it, and both end at their released ratios", async () => {
    const { asked, edit } = heldEdits();
    const writes = new DividerWrites({ edit, refused: () => {} });
    const A = { first: "a", second: "b", direction: "right" } as const;
    const B = { first: "b", second: "c", direction: "down" } as const;
    let root = TREE;
    let answered = 0;
    const outstanding = () => asked.length - answered;
    writes.move(1, "t", A, 0.3, false);
    // A is released at another ratio while its first write is held, then B is dragged and released
    writes.move(1, "t", A, 0.6, true);
    writes.move(2, "t", B, 0.2, false);
    writes.move(2, "t", B, 0.25, true);
    expect(outstanding()).toBe(1);
    // drawn at both local ratios meanwhile
    expect(writes.shape("t", { root, zoomed: null })?.root).toEqual(right(leaf("a"), down(leaf("b"), leaf("c"), 0.25), 0.6));
    while (outstanding() > 0) {
      const next = asked[answered]!;
      root = next.change(layoutOf(root)).layout!.workspaces[0]!.tabs[0]!.root;
      answered++;
      next.answer(null);
      await turn();
      expect(outstanding()).toBeLessThanOrEqual(1);
    }
    expect(root).toEqual(right(leaf("a"), down(leaf("b"), leaf("c"), 0.25), 0.6));
    expect(asked.length).toBe(3);
  });

  it("draws the newest ratio while it lasts, and after the release until the shown tree changes", async () => {
    const { asked, edit } = heldEdits();
    const writes = new DividerWrites({ edit, refused: () => {} });
    const shown = { root: right(leaf("a"), leaf("b")), zoomed: null };
    writes.move(1, "t", NAME, 0.3, false);
    expect(writes.shape("t", shown)?.root).toEqual(right(leaf("a"), leaf("b"), 0.3));
    expect(writes.shape("other", shown)).toBe(shown);
    writes.move(1, "t", NAME, 0.3, true);
    asked[0]!.answer(null);
    await turn();
    // answered, but the core's document has not come back yet: the local ratio stays drawn
    expect(writes.shape("t", shown)?.root).toEqual(right(leaf("a"), leaf("b"), 0.3));
    const confirmed = { root: right(leaf("a"), leaf("b"), 0.3), zoomed: null };
    expect(writes.shape("t", confirmed)).toBe(confirmed);
    expect(writes.shape("t", shown)).toBe(shown);
  });

  it("a release whose write is held keeps the tree drawn at the release: a rival's ratio seen first after the answer is drawn at once", async () => {
    const { asked, edit } = heldEdits();
    const writes = new DividerWrites({ edit, refused: () => {} });
    const shown = { root: right(leaf("a"), leaf("b")), zoomed: null };
    writes.move(1, "t", NAME, 0.3, false);
    writes.move(1, "t", NAME, 0.3, true);
    // drawn at the release, its write still held
    expect(writes.shape("t", shown)?.root).toEqual(right(leaf("a"), leaf("b"), 0.3));
    asked[0]!.answer(null);
    await turn();
    // another writer's ratio landed after this one's: the first tree drawn after the answer already holds it
    const rival = { root: right(leaf("a"), leaf("b"), 0.75), zoomed: null };
    expect(writes.shape("t", rival)).toBe(rival);
  });

  it("a divider gone from the fresh document: stale, the local ratio dropped, and the same grab writes nothing more", async () => {
    const { asked, edit } = heldEdits();
    const refusals: DividerRefusal[] = [];
    const writes = new DividerWrites({ edit, refused: (refusal) => refusals.push(refusal) });
    const shown = { root: right(leaf("a"), leaf("b")), zoomed: null };
    writes.move(1, "t", NAME, 0.3, false);
    // the change itself answers stale on a document where a and b lie one over the other
    expect(asked[0]!.change(layoutOf(down(leaf("a"), leaf("b"))))).toEqual({ layout: null, reason: "stale" });
    asked[0]!.answer("stale");
    await turn();
    expect(refusals).toEqual([{ code: "stale", reason: null }]);
    expect(writes.shape("t", shown)).toBe(shown);
    writes.move(1, "t", NAME, 0.4, false);
    writes.move(1, "t", NAME, 0.4, true);
    expect(asked.length).toBe(1);
    // a new press grabs again
    writes.move(2, "t", NAME, 0.4, false);
    expect(asked.length).toBe(2);
  });

  it("a refused write ends only the grab that issued it: a newer grab of the same divider released meanwhile still writes its ratio", async () => {
    const { asked, edit } = heldEdits();
    const refusals: DividerRefusal[] = [];
    const writes = new DividerWrites({ edit, refused: (refusal) => refusals.push(refusal) });
    writes.move(1, "t", NAME, 0.3, false);
    writes.move(1, "t", NAME, 0.3, true);
    // grabbed again and released before the first write is answered, at the same ratio and then another
    writes.move(2, "t", NAME, 0.3, false);
    writes.move(2, "t", NAME, 0.45, true);
    asked[0]!.fail(Object.assign(new Error("refused"), { code: "unsupported" }));
    await turn();
    expect(asked.map((one) => ratioWritten(one.change))).toEqual([0.3, 0.45]);
    expect(refusals).toEqual([]);
    expect(writes.shape("t", { root: right(leaf("a"), leaf("b")), zoomed: null })?.root).toEqual(right(leaf("a"), leaf("b"), 0.45));
    asked[1]!.answer(null);
    await turn();
    expect(asked.length).toBe(2);
  });

  it("a refused write: the error's code, the local ratio dropped", async () => {
    const { asked, edit } = heldEdits();
    const refusals: DividerRefusal[] = [];
    const writes = new DividerWrites({ edit, refused: (refusal) => refusals.push(refusal) });
    writes.move(1, "t", NAME, 0.3, false);
    asked[0]!.fail(Object.assign(new Error("the Herdr app arranges this core"), { code: "unsupported" }));
    await turn();
    expect(refusals).toEqual([{ code: "layout_refused", reason: "unsupported" }]);
    const shown = { root: right(leaf("a"), leaf("b")), zoomed: null };
    expect(writes.shape("t", shown)).toBe(shown);
  });
});
