import { afterEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import { Stepper } from "./SettingsControls.tsx";

/** A key on the size field, as React hands it over: `composing` while an IME still holds the draft. */
const key = (name: string, composing: boolean) => ({
  key: name,
  nativeEvent: { isComposing: composing, keyCode: composing ? 229 : name === "Enter" ? 13 : 27 },
  stopPropagation() {},
});

describe("the typed font size (G-179)", () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; });

  const mount = () => {
    const changes: number[] = [];
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    act(() => {
      renderer = create(createElement(Stepper, { label: "Terminal font size", value: 14, text: "14px", min: 10, max: 22, decreaseLabel: "Smaller", increaseLabel: "Larger", unit: "px", onChange: (value: number) => changes.push(value) }));
    });
    const field = () => renderer!.root.findByType("input");
    return { changes, field };
  };

  it("leaves Enter and Escape to an IME while it composes, then commits the finished number", () => {
    const { changes, field } = mount();
    act(() => field().props.onChange({ target: { value: "16" } }));
    // the IME's own Enter confirms its text: the draft is not committed yet
    act(() => field().props.onKeyDown(key("Enter", true)));
    expect(changes).toEqual([]);
    expect(field().props.value).toBe("16");
    // nor does its Escape throw the draft away
    act(() => field().props.onKeyDown(key("Escape", true)));
    expect(field().props.value).toBe("16");
    act(() => field().props.onKeyDown(key("Enter", false)));
    expect(changes).toEqual([16]);
  });

  it("reads a pasted number whole and refuses one out of range", () => {
    const { changes, field } = mount();
    act(() => field().props.onChange({ target: { value: "200" } }));
    act(() => field().props.onKeyDown(key("Enter", false)));
    expect(changes).toEqual([]);
    expect(field().props.value).toBe("14");
  });
});
