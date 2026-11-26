/**
 * A browser page for component and hook tests: happy-dom's window, document and navigator as globals,
 * and a react-dom root in its body, the way the app renders. Timers and fetch stay Bun's, so fake
 * timers and fetch spies work as before.
 */
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const GLOBALS = ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"] as const;

export interface Page {
  readonly window: Window;
  /** Where the root renders. */
  readonly container: HTMLElement;
  /** Renders `node` into the root, mounting it on the first call. */
  render(node: ReactNode): Promise<void>;
  /** The one element in the container that `selector` matches; throws on none or several. */
  one<E extends Element = HTMLElement>(selector: string): E;
  /** Types `value` into a text field the way a user does: React's onChange sees it. */
  type(field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void>;
  /** Unmounts the root and puts back the globals the page replaced. */
  close(): Promise<void>;
}

export function openPage(url = "http://localhost/"): Page {
  const saved = new Map(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const window = new Window({ url });
  const values: Record<(typeof GLOBALS)[number], unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of GLOBALS) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  const container = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.appendChild(container as never);
  let root: Root | null = null;
  return {
    window,
    container,
    async render(node) {
      await act(async () => {
        root ??= createRoot(container);
        root.render(node);
      });
    },
    one<E extends Element>(selector: string): E {
      const found = container.querySelectorAll<E>(selector);
      if (found.length !== 1) throw new Error(`Expected 1 element matching ${selector}, found ${found.length}`);
      return found[0]!;
    },
    async type(field, value) {
      const prototype = field.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
        field.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
      });
    },
    async close() {
      await act(async () => { root?.unmount(); });
      root = null;
      await window.happyDOM.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
