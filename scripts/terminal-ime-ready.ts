import type { Page } from "playwright-core";

const IME_READY_TIMEOUT = 10_000;
const imeTerminal = (page: Page, pane: string) =>
  page.locator(`.pane-frame.is-current .terminal-stack[data-pane-owner=${JSON.stringify(pane)}]`);

export async function waitForImeTerminal(page: Page, pane: string): Promise<void> {
  // A routed input-ready frame has not necessarily reached the terminal yet.
  await imeTerminal(page, pane).locator('.key-bar [data-key="Control"]:enabled')
    .waitFor({ state: "attached", timeout: IME_READY_TIMEOUT });
}

export async function resetImeInput(page: Page, pane: string): Promise<void> {
  const deadline = Date.now() + IME_READY_TIMEOUT;
  const remaining = () => Math.max(1, deadline - Date.now());
  await waitForImeTerminal(page, pane);
  const terminal = imeTerminal(page, pane);
  await terminal.evaluate((stack) => {
    for (const key of stack.querySelectorAll<HTMLButtonElement>(".key-bar .key[data-latch]")) {
      // A modifier held for one key becomes locked on the next click, then releases.
      if (key.dataset.latch === "once") key.click();
      key.click();
    }
    const box = stack.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
    // xterm's blur finishes replacement edits; refocus lets iOS put back its Backspace space.
    box.blur();
    box.value = "";
    box.focus();
  }, undefined, { timeout: remaining() });
  await terminal.filter({ hasNot: page.locator(".composition-view.active, .key-bar .key[data-latch]") })
    .locator(".xterm-helper-textarea:focus").waitFor({ state: "attached", timeout: remaining() });
}

export async function selectImePane(page: Page, pane: string): Promise<void> {
  await page.locator(`.pane-select[data-pane=${JSON.stringify(pane)}]`).first()
    .evaluate((node: HTMLElement) => node.click(), undefined, { timeout: IME_READY_TIMEOUT });
  await page.waitForFunction((pane) => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.pane_id === pane,
    pane, { timeout: IME_READY_TIMEOUT });
  await waitForImeTerminal(page, pane);
}
