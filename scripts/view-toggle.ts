/**
 * The header's lens toggle, for the browser scripts: one button at the end of the tabs says the lens
 * the open pane shows (its `data-view`) and flips to the other on a click (components/ViewToggle.tsx).
 */
import type { Page } from "playwright-core";

export const VIEW_BUTTON = ".app-header .view-toggle";

export type Lens = "chat" | "terminal";

/** Shows `lens`, tapped on a touch-only page: the toggle is pressed only when the other lens is shown. */
export async function pickLens(page: Page, lens: Lens, { tap = false }: { tap?: boolean } = {}): Promise<void> {
  const button = page.locator(VIEW_BUTTON);
  if ((await button.getAttribute("data-view")) !== lens) await (tap ? button.tap() : button.click());
  await page.locator(`${VIEW_BUTTON}[data-view="${lens}"]`).waitFor();
}

/** The lens the header says the open pane shows, once its button is there. */
export function shownLens(page: Page): Promise<string | null> {
  return page.locator(VIEW_BUTTON).getAttribute("data-view");
}
