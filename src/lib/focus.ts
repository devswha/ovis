export function focusWorkspaceListToggle(when: "always" | "lost" = "always"): void {
  window.requestAnimationFrame(() => {
    if (when === "lost" && document.activeElement !== null && document.activeElement !== document.body) return;
    const shown = (selector: string): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>(selector)].find((toggle) => toggle.getClientRects().length > 0);
    (shown(".app-header .drawer-toggle, .app-header .sidebar-toggle") ?? shown(".app-header .inbox-back"))?.focus();
  });
}

export function modalOpen(): boolean {
  return document.querySelector("[aria-modal='true'], dialog[open]") !== null;
}
