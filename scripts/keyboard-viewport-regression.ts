/**
 * bun scripts/keyboard-viewport-regression.ts
 * Runs the real viewport module and shell/composer CSS against controlled viewport
 * events. Chromium cannot emulate iOS keyboard dismissal or safe-area env() values;
 * only those platform inputs are faked. No live herdr session or production build.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";

async function checkState(page: Page, visible: boolean, height: number, inset: number, correction = false): Promise<void> {
  // lib/viewport.ts applies a shrinking visual viewport only once it lasted SHRINK_SETTLE_MS: the page's clock runs past it
  await page.clock.runFor(50);
  const state = await page.evaluate((visible) => {
    const composer = document.querySelector(".composer")!;
    const root = document.documentElement;
    return {
      keyboard: root.hasAttribute("data-keyboard"),
      published: root.style.getPropertyValue("--app-height"),
      height: document.querySelector(".app")!.getBoundingClientRect().height,
      padding: parseFloat(getComputedStyle(composer).paddingBottom),
      hostPadding: parseFloat(getComputedStyle(document.querySelector(".terminal-host")!).paddingBottom),
      bottom: composer.getBoundingClientRect().bottom,
      space: parseFloat(getComputedStyle(root).getPropertyValue(visible ? "--space-2" : "--space-4")),
    };
  }, visible);
  assert.equal(state.keyboard, visible, "keyboard flag follows occlusion, not focus alone");
  assert.equal(state.published, visible || correction ? `${height}px` : "", "height override follows keyboard or measured standalone inset");
  assert.equal(state.height, height, "unobstructed standalone shell remains 100dvh without a blank band");
  assert.equal(state.bottom, height, "composer stays at the shell bottom");
  assert.equal(state.padding, visible ? state.space : Math.max(state.space, inset - state.space), "home indicator padding is restored on dismissal");
  assert.equal(state.hostPadding, 0, "home-indicator inset is not duplicated by the host");
}

async function geometry(page: Page, height: number, layout: number, large: number, event = "resize", scale = 1): Promise<void> {
  await page.evaluate(({ height, layout, large, event, scale }) => {
    const fake = (window as any).viewportFixture;
    Object.assign(fake, { height, layout, large, scale });
    fake.viewport.dispatchEvent(new Event(event));
    window.dispatchEvent(new Event(event === "orientationchange" ? event : "resize"));
  }, { height, layout, large, event, scale });
}

const repo = join(import.meta.dir, "..");
const bundle = await Bun.build({ entrypoints: [join(repo, "src/lib/viewport.ts")], target: "browser" });
assert.ok(bundle.success, String(bundle.logs));
const js = bundle.outputs.find((output) => output.path.endsWith(".js"));
assert.ok(js);
const css = readFileSync(join(repo, "src/styles.css"), "utf8") + "\n" + readFileSync(join(repo, "src/components/Composer.css"), "utf8");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/viewport.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
  if (url.pathname === "/styles.css") {
    const inset = url.searchParams.get("inset") ?? "0";
    const fixtureCss = url.searchParams.has("short")
      ? css.replace("height: var(--app-height, 100dvh);", "height: var(--app-height, 793px);") + "\n@media (orientation: landscape) { .app { height: var(--app-height, 100dvh); } }"
      : css;
    return new Response(fixtureCss.replace(/env\(safe-area-inset-bottom,\s*0px\)/g, `${inset}px`), { headers: { "content-type": "text/css" } });
  }
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/styles.css?inset=${url.searchParams.get("inset") ?? "0"}${url.searchParams.has("short") ? "&short" : ""}"><style>.terminal-host{display:flex;flex-direction:column}.fixture-chat{flex:1;min-height:0}.xterm-helper-textarea{position:absolute;width:1px;height:1px;opacity:0}</style></head><body><div class="app"><div class="app-body"><div class="terminal-host"><div class="fixture-chat"></div><div class="composer"><textarea aria-label="Message"></textarea></div><textarea class="xterm-helper-textarea"></textarea></div></div></div><script src="/viewport.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
} });
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const scenario of ["mobile", "split-view", "desktop", "virtual-keyboard", "standalone", "standalone-full", "browser-short"] as const) {
    const mobile = scenario !== "desktop";
    const context = await browser.newContext({ viewport: mobile ? { width: 393, height: 852 } : { width: 1280, height: 800 }, isMobile: mobile, hasTouch: mobile });
    try {
      await context.addInitScript(({ mobile, virtualKeyboard, scenario }) => {
        // Init scripts run before the viewport meta tag is parsed. Playwright's
        // emulated screen, unlike innerHeight at that point, has the requested size.
        const initialHeight = window.screen.height;
        const fake = {
          height: initialHeight - (mobile ? (window.screen.width > initialHeight ? 21 : 59) : 0), layout: initialHeight, large: scenario === "standalone" || scenario === "browser-short" ? 793 : initialHeight,
          scale: 1, viewport: new EventTarget(), keyboard: new EventTarget(), keyboardHeight: 0,
        };
        Object.assign(window, { viewportFixture: fake });
        for (const key of ["height", "scale"] as const) Object.defineProperty(fake.viewport, key, { get: () => fake[key] });
        // a pinch zoom narrows the visual viewport by its scale; Safari's page zoom keeps the width (fake.width)
        Object.defineProperty(fake.viewport, "width", { get: () => fake.width ?? document.documentElement.clientWidth / fake.scale });
        Object.defineProperty(window, "visualViewport", { configurable: true, value: fake.viewport });
        Object.defineProperty(window, "innerHeight", { configurable: true, get: () => fake.layout });
        const originalMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = (query) => query === "(display-mode: standalone)"
          ? ({ matches: scenario.startsWith("standalone") } as MediaQueryList) : originalMatchMedia(query);
        const nativeRect = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = function () {
          // Fake only the module's rulers, never app layout.
          if (this.style.height === "100lvh") return new DOMRect(0, 0, 0, fake.large);
          if (this.style.height === "env(safe-area-inset-top, 0px)") return new DOMRect(0, 0, 0, mobile ? 59 : 0);
          return nativeRect.call(this);
        };
        if (virtualKeyboard) {
          Object.defineProperty(fake.keyboard, "boundingRect", { get: () => new DOMRect(0, 0, 393, fake.keyboardHeight) });
          Object.defineProperty(navigator, "virtualKeyboard", { configurable: true, value: fake.keyboard });
        } else Object.defineProperty(navigator, "virtualKeyboard", { configurable: true, value: undefined });
      }, { mobile, virtualKeyboard: scenario === "virtual-keyboard", scenario });
      const page = await context.newPage();
      await page.clock.install();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/?inset=${mobile ? 34 : 0}${scenario === "standalone" || scenario === "browser-short" ? "&short" : ""}`);
      await checkState(page, false, mobile ? scenario === "standalone" ? 852 : scenario === "browser-short" ? 793 : 852 : 800, mobile ? 34 : 0, scenario === "standalone");
      if (scenario === "standalone") {
        const bounds = await page.evaluate(() => {
          const composer = document.querySelector(".composer")!;
          const corrected = composer.getBoundingClientRect().bottom;
          document.documentElement.style.removeProperty("--app-height");
          const uncorrected = composer.getBoundingClientRect().bottom;
          window.dispatchEvent(new Event("resize"));
          return { corrected, uncorrected, padding: parseFloat(getComputedStyle(composer).paddingBottom) };
        });
        assert.deepEqual(bounds, { corrected: 852, uncorrected: 793, padding: 18 }, "status inset is added exactly once with home-indicator clearance");
      }
      await page.getByRole("textbox", { name: "Message", exact: true }).focus();
      await checkState(page, false, mobile ? scenario === "standalone" ? 852 : scenario === "browser-short" ? 793 : 852 : 800, mobile ? 34 : 0, scenario === "standalone"); // hardware keyboard / focus without soft keyboard
      if (scenario === "mobile") {
        // a hardware keyboard's one-frame shrink on each key (iPadOS 26) is not applied in its frame, and gone by the next
        await geometry(page, 472, 852, 852);
        assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-keyboard")), false, "a shrink waits before it counts");
        await geometry(page, 793, 852, 852);
        await checkState(page, false, 852, 34);
      }
      if (scenario === "split-view") {
        await page.setViewportSize({ width: 393, height: 1000 });
        await geometry(page, 976, 1000, 1000);
        await checkState(page, false, 1000, 34);
        // Same-width top/bottom split view changes the large/layout viewport,
        // while the visual viewport retains a small non-keyboard inset.
        await page.setViewportSize({ width: 393, height: 600 });
        await geometry(page, 576, 600, 600);
        await checkState(page, false, 600, 34); // focused hardware keyboard
        await geometry(page, 300, 600, 600);
        await checkState(page, true, 300, 34);
        await geometry(page, 576, 600, 600, "scroll");
        await checkState(page, false, 600, 34); // soft keyboard dismissed, still focused
        await page.getByRole("textbox", { name: "Message", exact: true }).blur();
        await page.getByRole("textbox", { name: "Message", exact: true }).focus();
        await checkState(page, false, 600, 34); // blur/refocus must not revive stale height
      } else if (scenario === "mobile") {
        await geometry(page, 472, 852, 852);
        await checkState(page, true, 472, 34);
        await geometry(page, 793, 852, 852, "scroll"); // native dismissal, focus remains
        assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).evaluate((el) => document.activeElement === el), true);
        await checkState(page, false, 852, 34);
        await geometry(page, 472, 472, 472); // resizes-content: both viewports and CSS units shrink
        await checkState(page, true, 472, 34);
        await geometry(page, 793, 852, 852);
        await checkState(page, false, 852, 34);
        await geometry(page, 400, 852, 852, "resize", 2); // pinch zoom is not a keyboard
        await checkState(page, false, 852, 34);
        await geometry(page, 793, 852, 852);
        // Safari page zoom 85%: the scale is below 1 but the visual viewport stays full width, so a keyboard still counts
        await page.evaluate(() => { (window as any).viewportFixture.width = document.documentElement.clientWidth; });
        await geometry(page, 472, 852, 852, "resize", 0.85);
        await checkState(page, true, 472, 34);
        await geometry(page, 793, 852, 852, "resize", 0.85);
        await checkState(page, false, 852, 34);
        await page.evaluate(() => { delete (window as any).viewportFixture.width; });
        await geometry(page, 793, 852, 852);
        await geometry(page, 210, 393, 393);
        await page.setViewportSize({ width: 852, height: 393 });
        await geometry(page, 210, 393, 393, "orientationchange"); // rotate with keyboard still open
        await checkState(page, true, 210, 34);
        await geometry(page, 372, 393, 393);
        await checkState(page, false, 393, 34);
        await page.goto(`http://127.0.0.1:${server.port}/?inset=21`);
        await geometry(page, 372, 393, 393);
        await page.getByRole("textbox", { name: "Message", exact: true }).focus();
        await checkState(page, false, 393, 21);
        await geometry(page, 210, 393, 393);
        await checkState(page, true, 210, 21);
        await geometry(page, 372, 393, 393);
        await checkState(page, false, 393, 21);
        await page.locator(".xterm-helper-textarea").focus();
        await geometry(page, 210, 393, 393);
        await checkState(page, false, 393, 21); // automatic xterm focus does not raise keyboard state
        await page.locator(".terminal-host").evaluate((el) => el.setAttribute("data-direct-typing", ""));
        await geometry(page, 210, 393, 393);
        await checkState(page, true, 210, 21);
      } else if (scenario === "standalone") {
        await geometry(page, 472, 852, 793);
        await checkState(page, true, 472, 34);
        await geometry(page, 793, 852, 793, "scroll");
        await checkState(page, false, 852, 34, true);
        await page.setViewportSize({ width: 852, height: 393 });
        await geometry(page, 372, 393, 393, "orientationchange");
        await checkState(page, false, 393, 34);
        await geometry(page, 210, 393, 393);
        await checkState(page, true, 210, 34);
        await geometry(page, 372, 393, 393);
        await checkState(page, false, 393, 34);
      } else if (scenario === "browser-short") {
        await geometry(page, 472, 852, 793);
        await checkState(page, true, 472, 34);
        await geometry(page, 793, 852, 793, "scroll");
        await checkState(page, false, 793, 34);
      } else if (scenario === "standalone-full") {
        await geometry(page, 472, 852, 852);
        await checkState(page, true, 472, 34);
        await geometry(page, 793, 852, 852, "scroll");
        await checkState(page, false, 852, 34);
      } else if (scenario === "virtual-keyboard") {
        await geometry(page, 793, 852, 852);
        await checkState(page, false, 852, 34);
        await page.evaluate(() => {
          const fake = (window as any).viewportFixture;
          fake.keyboardHeight = 300;
          fake.keyboard.dispatchEvent(new Event("geometrychange"));
        });
        await checkState(page, true, 793, 34); // geometry alone detects a keyboard
        await page.evaluate(() => {
          const fake = (window as any).viewportFixture;
          fake.keyboardHeight = 0;
          fake.keyboard.dispatchEvent(new Event("geometrychange"));
        });
        await checkState(page, false, 852, 34);
        await geometry(page, 472, 852, 852);
        await checkState(page, true, 472, 34);
        // Zero geometry must not mask visual occlusion on browsers exposing the API.
        await geometry(page, 793, 852, 852);
        await checkState(page, false, 852, 34);
      } else {
        await geometry(page, 400, 400, 800);
        await checkState(page, false, 800, 0); // desktop focus/resize never activates phone keyboard handling
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  // an iPad home-screen app in landscape: the visual viewport stops above the status bar while the shell would be
  // 100dvh tall, so the page could scroll by that band whenever a field takes the focus. The shell fits the visual
  // viewport, also at Safari's page zoom; a pinch, a keyboard-sized gap, a Safari tab or a phone keep the rules above
  for (const [name, size, visual, scale, pinched, standalone, fits] of [
    ["iPad landscape", { width: 1180, height: 820 }, 796, 1, false, true, true],
    ["iPad landscape at 85% page zoom", { width: 1180, height: 820 }, 796, 0.85, false, true, true],
    ["iPad landscape pinched", { width: 1180, height: 820 }, 796, 2, true, true, false],
    ["iPad landscape, keyboard-sized gap", { width: 1180, height: 820 }, 500, 1, false, true, false],
    ["iPad landscape Safari tab", { width: 1180, height: 820 }, 796, 1, false, false, false],
    ["phone landscape", { width: 852, height: 393 }, 372, 1, false, true, false],
  ] as const) {
    const context = await browser.newContext({ viewport: size, screen: size, isMobile: true, hasTouch: true });
    try {
      await context.addInitScript(({ layout, visual, scale, pinched, standalone }) => {
        const fake = new EventTarget();
        Object.defineProperty(fake, "height", { get: () => visual });
        Object.defineProperty(fake, "scale", { get: () => scale });
        Object.defineProperty(fake, "width", { get: () => document.documentElement.clientWidth / (pinched ? scale : 1) });
        Object.defineProperty(window, "visualViewport", { configurable: true, value: fake });
        Object.defineProperty(window, "innerHeight", { configurable: true, get: () => layout });
        const originalMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = (query) => query === "(display-mode: standalone)" ? ({ matches: standalone } as MediaQueryList) : originalMatchMedia(query);
        const nativeRect = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = function () {
          if (this.style.height === "100lvh") return new DOMRect(0, 0, 0, layout);
          if (this.style.height === "env(safe-area-inset-top, 0px)") return new DOMRect(0, 0, 0, 24);
          return nativeRect.call(this);
        };
      }, { layout: size.height, visual, scale, pinched, standalone });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/`);
      const shell = await page.evaluate(() => ({ published: document.documentElement.style.getPropertyValue("--app-height"), height: document.querySelector(".app")!.getBoundingClientRect().height }));
      assert.deepEqual(shell, fits ? { published: `${visual}px`, height: visual } : { published: "", height: size.height }, `${name}: the shell ${fits ? "fits the visual viewport" : "keeps 100dvh"}`);
    } finally { await context.close(); }
  }
  // a field draws at the interface size like the label beside it (--fs-md on a phone, --fs-sm from 641px); on iOS the
  // press before its focus arms it to 16px, the size Safari does not zoom the page for, and the blur disarms it. A
  // desktop browser never arms it
  for (const [ios, width] of [[true, 393], [true, 1180], [false, 1180]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 820 }, hasTouch: ios });
    try {
      if (ios) await context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => "MacIntel" });
        Object.defineProperty(Navigator.prototype, "maxTouchPoints", { configurable: true, get: () => 5 });
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.evaluate((token) => document.querySelector(".app")!.insertAdjacentHTML("afterbegin", `<input class="input" aria-label="Field"><select class="select" aria-label="Choice"><option>a</option></select><span class="fixture-label" style="font-size: var(${token})">Label</span>`), width < 641 ? "--fs-md" : "--fs-sm");
      const size = (selector: string) => page.locator(selector).evaluate((el) => getComputedStyle(el).fontSize);
      const body = await size(".fixture-label");
      const where = `${ios ? "iOS" : "desktop"} ${width}px`;
      for (const selector of ['.input[aria-label="Field"]', ".select"]) {
        assert.equal(await size(selector), body, `${where} ${selector}: the interface size at rest`);
        await page.locator(selector).dispatchEvent("pointerdown");
        await page.locator(selector).focus();
        assert.equal(await size(selector), ios ? "16px" : body, `${where} ${selector}: ${ios ? "16px from the press" : "the interface size when focused"}`);
        await page.locator(selector).blur();
        assert.equal(await size(selector), body, `${where} ${selector}: the interface size again after the blur`);
      }
      // a press on a field's label arms the field it focuses; a press a scroll cancels leaves no armed field behind
      await page.evaluate(() => document.querySelector(".app")!.insertAdjacentHTML("afterbegin", '<label for="fixture-dir">Directory</label><input id="fixture-dir" class="input">'));
      await page.locator('label[for="fixture-dir"]').dispatchEvent("pointerdown");
      await page.locator('label[for="fixture-dir"]').click();
      assert.equal(await size("#fixture-dir"), ios ? "16px" : body, `${where}: ${ios ? "16px from a press on its label" : "a label press leaves the size"}`);
      await page.locator("#fixture-dir").blur();
      await page.locator('.input[aria-label="Field"]').dispatchEvent("pointerdown");
      await page.locator('.input[aria-label="Field"]').dispatchEvent("pointercancel");
      assert.equal(await size('.input[aria-label="Field"]'), body, `${where}: a cancelled press disarms the field`);
      // a press on a button whose handler focuses a field (Find in diff, Rename tab) arms the field it focuses
      await page.evaluate(() => {
        document.querySelector(".app")!.insertAdjacentHTML("afterbegin", '<button type="button" id="fixture-find">Find</button><input id="fixture-search" class="input">');
        document.querySelector("#fixture-find")!.addEventListener("click", () => document.querySelector<HTMLElement>("#fixture-search")!.focus());
      });
      await page.locator("#fixture-find").dispatchEvent("pointerdown");
      await page.locator("#fixture-find").click();
      assert.equal(await size("#fixture-search"), ios ? "16px" : body, `${where}: ${ios ? "16px for a field a button's press focuses" : "a focused field keeps the interface size"}`);
      await page.locator("#fixture-search").blur();
      assert.equal(await size("#fixture-search"), body, `${where}: the interface size again after the blur`);
    } finally { await context.close(); }
  }
  // an interface size over 16px: the press keeps the field at the interface size instead of shrinking it to 16px
  for (const width of [393, 1180]) {
    const context = await browser.newContext({ viewport: { width, height: 820 }, hasTouch: true });
    try {
      await context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => "iPhone" });
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/`);
      // a 20px interface body size over the 14px default, as lib/settings.ts writes it on <html>
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--ui-scale", String(20 / 14));
        document.querySelector(".app")!.insertAdjacentHTML("afterbegin", '<input class="input" aria-label="Large field">');
      });
      const field = page.locator('.input[aria-label="Large field"]');
      const rest = await field.evaluate((el) => getComputedStyle(el).fontSize);
      assert.ok(Number.parseFloat(rest) > 16, `iOS ${width}px: the field follows a 20px interface (${rest})`);
      await field.dispatchEvent("pointerdown");
      await field.focus();
      assert.equal(await field.evaluate((el) => getComputedStyle(el).fontSize), rest, `iOS ${width}px: the press keeps a size over 16px`);
    } finally { await context.close(); }
  }
  // an iPad home-screen app in a window (iPadOS 26): the window's controls sit over the page's top-left corner, so
  // the header's first button moves clear of them, by the controls' width in points through Safari's page zoom.
  // A full-screen app, a Safari tab and a desktop browser keep the header as it is.
  for (const [name, width, scale, standalone, ipad, room] of [
    ["windowed", 800, 1, true, true, 68], ["windowed at 85% page zoom", 941, 0.85, true, true, 80],
    ["full screen", 1180, 1, true, true, null], ["Safari tab", 800, 1, false, true, null], ["desktop", 800, 1, true, false, null],
  ] as const) {
    const context = await browser.newContext({ viewport: { width, height: 820 }, screen: { width: 1180, height: 820 }, hasTouch: ipad });
    try {
      await context.addInitScript(({ width, scale, standalone, ipad }) => {
        if (ipad) {
          Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => "MacIntel" });
          Object.defineProperty(Navigator.prototype, "maxTouchPoints", { configurable: true, get: () => 5 });
        }
        const fake = new EventTarget();
        for (const [key, value] of [["width", width], ["height", 820], ["scale", scale]] as const) Object.defineProperty(fake, key, { get: () => value });
        Object.defineProperty(window, "visualViewport", { configurable: true, value: fake });
        const originalMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = (query) => query === "(display-mode: standalone)" ? ({ matches: standalone } as MediaQueryList) : originalMatchMedia(query);
      }, { width, scale, standalone, ipad });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/`);
      const header = await page.evaluate(() => {
        const header = document.createElement("header");
        header.className = "app-header";
        document.querySelector(".app")!.prepend(header);
        return { marked: document.documentElement.hasAttribute("data-window-controls"), padding: parseFloat(getComputedStyle(header).paddingLeft) };
      });
      assert.equal(header.marked, room !== null, `${name}: the window's controls are ${room === null ? "not " : ""}there`);
      if (room !== null) assert.equal(header.padding, room, `${name}: the header leaves the controls' room`);
    } finally { await context.close(); }
  }
  console.log("PASS mobile viewport: same-width split view, dismissal without blur, hardware keyboard, dual viewport resize, orientation, standalone, safe area, desktop, zoom, page zoom, xterm, keyboard geometry, one-frame shrink, iPad landscape home-screen shell, field size on iOS, iPad window controls");
} finally { await browser?.close(); server.stop(); }
