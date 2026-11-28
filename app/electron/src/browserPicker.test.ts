import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { cropRectForElement, parsePickedMeta, PICKER_SCRIPT } from "./browserPicker.ts";

describe("browserPicker helpers", () => {
  it("parses valid picked metadata and drops invalid payloads", () => {
    expect(parsePickedMeta(null)).toBeNull();
    expect(parsePickedMeta({ tag: "" })).toBeNull();
    expect(parsePickedMeta({ tag: "button", rect: { x: -1, y: 0, width: 10, height: 10 } })).toBeNull();
    expect(parsePickedMeta({
      tag: "button",
      role: "button",
      id: "submit-btn",
      classes: ["btn", "primary", "", 42],
      name: "Continue",
      text: "Continue to payment",
      rect: { x: 10.4, y: 20.6, width: 120.2, height: 36.8 },
    })).toEqual({
      tag: "button",
      role: "button",
      id: "submit-btn",
      classes: ["btn", "primary"],
      name: "Continue",
      text: "Continue to payment",
      rect: { x: 10, y: 21, width: 120, height: 37 },
    });
  });

  it("pads and clamps crop rectangles within the view bounds at the tab zoom factor", () => {
    expect(cropRectForElement({ x: 0, y: 0, width: 100, height: 40 }, { width: 800, height: 600 }, 1)).toEqual({
      x: 0,
      y: 0,
      width: 112,
      height: 52,
    });
    expect(cropRectForElement({ x: 100, y: 50, width: 80, height: 30 }, { width: 500, height: 400 }, 1.5)).toEqual({
      x: 132,
      y: 57,
      width: 156,
      height: 81,
    });
    expect(cropRectForElement({ x: 0, y: 0, width: 0, height: 20 }, { width: 800, height: 600 }, 1)).toBeNull();
  });

  it("picks an element in DOM without leaking password or input values, and cleans up the overlay", async () => {
    const win = new Window({ url: "http://localhost:5173/" });
    win.innerWidth = 800;
    win.innerHeight = 600;
    const raf = (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    };
    win.requestAnimationFrame = raf as unknown as typeof win.requestAnimationFrame;

    win.document.body.innerHTML = `
      <div id="checkout-card" class="card primary">
        <h2>Checkout</h2>
        <label for="secret-pw">Password</label>
        <input id="secret-pw" type="password" value="s3cr3t-password" title="Secret title" />
        <input id="card-num" type="text" value="4111-1111" />
        <textarea>private-note</textarea>
        <button id="pay-btn" role="button" aria-label="Continue to payment">Continue</button>
      </div>
    `;
    const card = win.document.getElementById("checkout-card")!;
    const pw = win.document.getElementById("secret-pw")!;
    const rect = { left: 20, top: 30, right: 320, bottom: 180, width: 300, height: 150, x: 20, y: 30, toJSON: () => ({}) };
    card.getBoundingClientRect = () => rect as unknown as ReturnType<typeof card.getBoundingClientRect>;
    pw.getBoundingClientRect = () => ({ left: 30, top: 60, right: 200, bottom: 90, width: 170, height: 30, x: 30, y: 60, toJSON: () => ({}) }) as unknown as ReturnType<typeof pw.getBoundingClientRect>;

    const runScript = new Function("window", "document", "globalThis", "requestAnimationFrame", `return (${PICKER_SCRIPT});`);

    // 1. Picking the card skips all input/password/textarea values while keeping safe heading/button text
    const scope1: Record<string, unknown> = {};
    (win.document as unknown as { elementFromPoint: (x: number, y: number) => unknown }).elementFromPoint = () => card;
    const pickedCardPromise = runScript(win, win.document, scope1, raf) as Promise<unknown>;
    expect(win.document.querySelectorAll("[data-ovis-picker]").length).toBe(2);
    win.dispatchEvent(new win.MouseEvent("mousemove", { clientX: 50, clientY: 50 }));
    win.dispatchEvent(new win.MouseEvent("click", { clientX: 50, clientY: 50, cancelable: true }));
    const pickedCard = parsePickedMeta(await pickedCardPromise);
    expect(pickedCard).not.toBeNull();
    expect(pickedCard?.tag).toBe("div");
    expect(pickedCard?.id).toBe("checkout-card");
    expect(pickedCard?.classes).toEqual(["card", "primary"]);
    expect(pickedCard?.text).toContain("Checkout");
    expect(pickedCard?.text).toContain("Continue");
    expect(pickedCard?.text).not.toContain("s3cr3t-password");
    expect(pickedCard?.text).not.toContain("4111-1111");
    expect(pickedCard?.text).not.toContain("private-note");
    expect(win.document.querySelectorAll("[data-ovis-picker]").length).toBe(0);

    // 2. Picking the password input directly never reads value or title
    const scope2: Record<string, unknown> = {};
    (win.document as unknown as { elementFromPoint: (x: number, y: number) => unknown }).elementFromPoint = () => pw;
    const pickedPwPromise = runScript(win, win.document, scope2, raf) as Promise<unknown>;
    win.dispatchEvent(new win.MouseEvent("click", { clientX: 50, clientY: 70, cancelable: true }));
    const pickedPw = parsePickedMeta(await pickedPwPromise);
    expect(pickedPw?.tag).toBe("input");
    expect(pickedPw?.text).toBe("");
    expect(pickedPw?.name).not.toContain("s3cr3t");
    expect(pickedPw?.name).not.toContain("Secret title");

    // 3. Pressing Escape cancels cleanly and removes overlay
    const scope3: Record<string, unknown> = {};
    const cancelledPromise = runScript(win, win.document, scope3, raf) as Promise<unknown>;
    expect(win.document.querySelectorAll("[data-ovis-picker]").length).toBe(2);
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(await cancelledPromise).toBeNull();
    expect(win.document.querySelectorAll("[data-ovis-picker]").length).toBe(0);

    await win.happyDOM.close();
  });
});
