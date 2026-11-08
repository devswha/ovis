/**
 * A press that selects another pane can move what it pressed before the release: the selection
 * closes a file docked beside the panes, and the panes widen under the pointer (#3368). The browser
 * then sends the press's click to an element holding the button, not to the button. This sends that
 * click on to the button when it lands where the button was when pressed; a release dragged off that
 * place still cancels the click, as it does on a button that stayed put.
 */
export function keepPressedButtonClick(press: { target: EventTarget | null }, previous: { current: AbortController | null }): void {
  previous.current?.abort();
  const button = press.target instanceof Element ? press.target.closest("button") : null;
  if (button === null) return;
  const box = button.getBoundingClientRect();
  const watch = new AbortController();
  previous.current = watch;
  window.addEventListener("click", (click) => {
    watch.abort();
    if (!(click.target instanceof Node) || button.contains(click.target) || !button.isConnected) return;
    if (click.clientX < box.left || click.clientX > box.right || click.clientY < box.top || click.clientY > box.bottom) return;
    button.click();
  }, { capture: true, signal: watch.signal });
  window.addEventListener("pointercancel", () => watch.abort(), { signal: watch.signal });
}
