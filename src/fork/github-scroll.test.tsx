import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { create } from "react-test-renderer";
import { useKeptScroll } from "./github.ts";

let previous: PropertyDescriptor | undefined;
beforeEach(() => { previous = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame"); Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} }); });
afterEach(() => { if (previous) Object.defineProperty(globalThis, "cancelAnimationFrame", previous); else Reflect.deleteProperty(globalThis, "cancelAnimationFrame"); });
class ScrollHost extends EventTarget { scrollTop = 0; }
function Scroller({ name, visible }: { name: string; visible: boolean }) {
  const ref = useKeptScroll<HTMLDivElement>(name, visible);
  return visible ? <div ref={ref} /> : null;
}

test("restores and records scrolling after the phone list returns", async () => {
  const hosts: ScrollHost[] = [];
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<Scroller name="test-phone" visible />, { createNodeMock: () => { const host = new ScrollHost(); hosts.push(host); return host; } }); });
  hosts[0]!.scrollTop = 250; hosts[0]!.dispatchEvent(new Event("scroll"));
  await act(async () => { tree.update(<Scroller name="test-phone" visible={false} />); });
  await act(async () => { tree.update(<Scroller name="test-phone" visible />); });
  expect(hosts[1]!.scrollTop).toBe(250);
  hosts[1]!.scrollTop = 320; hosts[1]!.dispatchEvent(new Event("scroll"));
  await act(async () => { tree.update(<Scroller name="test-phone" visible={false} />); });
  await act(async () => { tree.update(<Scroller name="test-phone" visible />); });
  expect(hosts[2]!.scrollTop).toBe(320);
  await act(async () => tree.unmount());
});

test("a first-visited tab starts at the top of the shared element", async () => {
  const host = new ScrollHost();
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<Scroller name="test-tab-one" visible />, { createNodeMock: () => host }); });
  host.scrollTop = 250; host.dispatchEvent(new Event("scroll"));
  await act(async () => { tree.update(<Scroller name="test-tab-two" visible />); });
  expect(host.scrollTop).toBe(0);
  await act(async () => tree.unmount());
});
