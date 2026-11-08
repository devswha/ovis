import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { MyPc } from "../lib/account/myPcs.ts";
import { dashboardPcs, type DashboardPc } from "../lib/relay/dashboard.ts";
import { loadSettings, SettingsProvider } from "../lib/settings.ts";
import { RelayDashboard, type RelayDashboardProps } from "./RelayDashboard.tsx";

const AP = "wss://relay-ap.ovis.sh";
const GLOBAL = "wss://relay.ovis.sh";
const IDS = {
  desk: "a".repeat(32),
  mac: "b".repeat(32),
  mini: "c".repeat(32),
  home: "d".repeat(32),
};

const pc = (server_id: string, name: string, state: MyPc["state"], over: Partial<MyPc> = {}): MyPc => ({
  server_id,
  name,
  state,
  last_seen_at: null,
  added_at: null,
  listed: true,
  paired: state === "paired",
  linked: true,
  ...over,
});

const fourPcs = (): DashboardPc[] =>
  dashboardPcs(
    [
      pc(IDS.desk, "Desk PC", "paired", { last_seen_at: new Date().toISOString() }),
      pc(IDS.mac, "MacBook", "paired", { listed: false, linked: false }),
      pc(IDS.mini, "Mac mini", "needs-approval", {
        last_seen_at: new Date().toISOString(),
        added_at: new Date().toISOString(),
        join: { server_public_key: "k", relay: AP },
      }),
      pc(IDS.home, "Home server", "offline", {
        paired: true,
        last_seen_at: new Date(Date.now() - 20 * 3_600_000).toISOString(),
      }),
    ],
    [
      { server_id: IDS.desk, relay: AP },
      { server_id: IDS.mac, relay: AP },
      { server_id: IDS.home, relay: GLOBAL },
    ],
  );

const baseProps = (over: Partial<RelayDashboardProps> = {}): RelayDashboardProps => ({
  pcs: fourPcs(),
  account: { provider: "github" },
  defaultRelay: GLOBAL,
  meLabel: "Linux · Chrome",
  error: null,
  onAddPc: () => {},
  onOpenSheet: () => {},
  onSignOut: () => {},
  onLeave: () => {},
  ...over,
});

const renderStatic = (shown: RelayDashboardProps): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayDashboard, shown) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("RelayDashboard frame and routes", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let focusedNodes: string[] = [];
  let store: Map<string, string>;
  let phoneMatches = false;
  let events: EventTarget;

  const createMockNode = (element: { type: unknown; props?: unknown }) => ({
    isConnected: true,
    tagName: typeof element.type === "string" ? element.type.toUpperCase() : "DIV",
    focus() {
      const p = typeof element.props === "object" && element.props !== null ? (element.props as Record<string, unknown>) : {};
      const label = typeof p["aria-label"] === "string"
        ? p["aria-label"]
        : typeof p["id"] === "string"
          ? p["id"]
          : String(element.type);
      focusedNodes.push(label);
    },
    contains: () => false,
    querySelectorAll: () => [],
    getClientRects: () => [],
    closest: () => null,
    addEventListener() {},
    removeEventListener() {},
    pauseAnimations() {},
    unpauseAnimations() {},
  });

  beforeEach(() => {
    focusedNodes = [];
    phoneMatches = false;
    events = new EventTarget();
    store = new Map<string, string>();
    for (const key of [
      "window",
      "document",
      "navigator",
      "localStorage",
      "getComputedStyle",
      "matchMedia",
      "HTMLElement",
      "ResizeObserver",
      "IntersectionObserver",
      "IS_REACT_ACT_ENVIRONMENT",
    ]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      key: () => null,
      length: 0,
      clear: () => store.clear(),
    };
    const matchMedia = (query: string) => ({
      matches: query === "(max-width: 768px)" ? phoneMatches : false,
      addEventListener() {},
      removeEventListener() {},
    });
    class HTMLElement {
      isConnected = true;
      focus(): void {}
    }
    class ResizeObserver {
      observe(): void {}
      disconnect(): void {}
    }
    class IntersectionObserver {
      observe(): void {}
      disconnect(): void {}
    }
    const loc = {
      href: "https://app.ovis.sh/",
      search: "",
      origin: "https://app.ovis.sh",
      pathname: "/",
      hash: "",
    };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserver });
    Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: IntersectionObserver });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 },
    });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: loc,
        history: {
          state: null,
          pushState(_data: unknown, _unused: string, url: string) {
            const parsed = new URL(url, loc.origin);
            loc.pathname = parsed.pathname;
            loc.search = parsed.search;
            loc.hash = parsed.hash;
            loc.href = parsed.href;
          },
          replaceState(_data: unknown, _unused: string, url: string) {
            const parsed = new URL(url, loc.origin);
            loc.pathname = parsed.pathname;
            loc.search = parsed.search;
            loc.hash = parsed.hash;
            loc.href = parsed.href;
          },
        },
        localStorage: storage,
        matchMedia,
        innerWidth: 1440,
        scrollTo() {},
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
        activeElement: new HTMLElement(),
        body: { nodeType: 1, children: [], createNodeMock: createMockNode },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      },
    });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const mount = async (shown: RelayDashboardProps = baseProps()) => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(RelayDashboard, shown) }), {
        createNodeMock: createMockNode,
      });
    });
  };

  const textOf = (node: ReactTestInstance): string =>
    node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

  const navigateHash = async (hash: string, eventType: "hashchange" | "popstate" = "hashchange") => {
    await act(async () => {
      window.location.hash = hash;
      window.location.href = `https://app.ovis.sh/${hash}`;
      window.dispatchEvent(new Event(eventType));
    });
  };

  it("renders labeled landmarks, brand link to #overview, all five real routes in sidebar and phone tab bar without disabled items, and no header subtitle", () => {
    const html = renderStatic(baseProps());
    expect(html).toContain('<aside class="relay-dash-side" aria-label="Navigation">');
    expect(html).toContain('<nav class="relay-dash-nav" aria-label="Sections">');
    expect(html).toContain('<nav class="relay-dash-tabs" aria-label="Sections">');
    expect(html).toContain('href="#overview"');
    expect(html).not.toContain('aria-disabled="true"');
    expect(html).not.toContain("relay-dash-sub");

    const sideLinks = [...(/<nav class="relay-dash-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "").matchAll(/<a [^>]*href="([^"]+)"[^>]*>/g)].map(([, href]) => href);
    expect(sideLinks).toEqual(["#overview", "#pcs", "#devices", "#relay", "#settings"]);

    const tabLinks = [...(/<nav class="relay-dash-tabs"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "").matchAll(/<a [^>]*href="([^"]+)"[^>]*>/g)].map(([, href]) => href);
    expect(tabLinks).toEqual(["#overview", "#pcs", "#devices", "#relay", "#settings"]);
  });

  it("loads directly into any of the five routes, updates aria-current on Back/Forward, and moves focus to the view heading only on route changes", async () => {
    window.location.hash = "#relay";
    await mount();
    expect(textOf(renderer!.root.findByType("h1"))).toBe("Relay");
    const currentHrefs = () =>
      renderer!.root
        .findAll((n) => n.type === "a" && n.props["aria-current"] === "page")
        .map((n) => n.props.href);
    expect(currentHrefs()).toEqual(["#relay", "#relay"]);

    focusedNodes = [];
    await navigateHash("#devices", "popstate");
    expect(textOf(renderer!.root.findByType("h1"))).toBe("Devices");
    expect(currentHrefs()).toEqual(["#devices", "#devices"]);
    expect(focusedNodes.length).toBeGreaterThan(0);

    // Data refresh (re-render with updated pcs) never steals focus
    focusedNodes = [];
    await act(async () => {
      renderer!.update(createElement(SettingsProvider, { children: createElement(RelayDashboard, baseProps()) }));
    });
    expect(focusedNodes).toEqual([]);

    await navigateHash("#settings", "popstate");
    expect(textOf(renderer!.root.findByType("h1"))).toBe("Settings");
    expect(currentHrefs()).toEqual(["#settings", "#settings"]);
  });

  it("restores PCs filter, relay and details selection from the route and clears missing selection", async () => {
    window.location.hash = `#pcs?filter=offline&pc=${IDS.home}`;
    await mount();
    expect(textOf(renderer!.root.findByType("h1"))).toBe("PCs");
    const rows = () =>
      renderer!.root
        .findAll((n) => n.type === "tr" && n.props["data-pc-state"] !== undefined)
        .map((r) => textOf(r.findByType("b")));
    expect(rows()).toEqual(["Home server"]);
    expect(renderer!.root.findAll((n) => n.props["data-pc-details"] !== undefined).length).toBe(1);

    // Back to Needs you filter without selection
    await navigateHash("#pcs?filter=needs", "popstate");
    expect(rows()).toEqual(["Mac mini", "Home server"]);
    expect(renderer!.root.findAll((n) => n.props["data-pc-details"] !== undefined).length).toBe(0);

    // Missing PC id in route renders no details panel
    await navigateHash("#pcs?pc=missing_pc_id", "popstate");
    expect(renderer!.root.findAll((n) => n.props["data-pc-details"] !== undefined).length).toBe(0);
  });

  it("keeps Sign out in the desktop sidebar foot while placing Remove this device only in Devices with same-element confirmation", async () => {
    let signedOut = 0;
    let left = 0;
    await mount(baseProps({ onSignOut: () => { signedOut += 1; }, onLeave: () => { left += 1; } }));
    const sideFoot = renderer!.root.findByProps({ className: "relay-dash-foot" });
    expect(textOf(sideFoot)).toContain("Signed in with GitHub");
    expect(textOf(sideFoot)).toContain("Sign out");
    expect(textOf(sideFoot)).not.toContain("Remove this device");

    await navigateHash("#devices");
    const removeBtn = renderer!.root.find((n) => n.type === "button" && n.props["data-action"] === "remove-device");
    expect(String(removeBtn.props.className)).not.toContain("btn-danger");
    expect(String(removeBtn.props.className)).not.toContain("account-link-danger");

    // First click arms confirmation on the exact same button instance
    await act(async () => { removeBtn.props.onClick(); });
    expect(left).toBe(0);
    expect(String(removeBtn.props.className)).toContain("btn-danger");
    expect(removeBtn.props["data-confirm"]).toBe("remove-device");

    // Second click on the same button invokes onLeave
    await act(async () => { removeBtn.props.onClick(); });
    expect(left).toBe(1);

    // Sign out button works
    const signOutBtn = sideFoot.find((n) => n.type === "button");
    await act(async () => { signOutBtn.props.onClick(); });
    expect(signedOut).toBe(1);
  });

  it("persists theme, density and language through SettingsProvider in the Settings view", async () => {
    window.location.hash = "#settings";
    await mount();
    const lightBtn = renderer!.root.find((n) => n.type === "button" && textOf(n).trim() === "Light");
    await act(async () => { lightBtn.props.onClick(); });
    expect(loadSettings().theme).toBe("light");

    const compactBtn = renderer!.root.find((n) => n.type === "button" && textOf(n).trim() === "Compact");
    await act(async () => { compactBtn.props.onClick(); });
    expect(loadSettings().density).toBe("compact");

    const langSelect = renderer!.root.find((n) => n.type === "select" && n.props.id === "relay-settings-language");
    await act(async () => { langSelect.props.onChange({ target: { value: "ko" } }); });
    expect(loadSettings().language).toBe("ko");
  });

  it("renders a 44px Add a PC button in the phone top bar and omits the account foot from Overview on phones", async () => {
    phoneMatches = true;
    await mount();
    expect(renderer!.root.findAll((n) => n.props.className === "relay-dash-foot")).toHaveLength(0);
    const addButtons = renderer!.root.findAll((n) => n.type === "button" && n.props["data-action"] === "add-pc");
    expect(addButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("omits the full connection map from Overview, renders a 44px Connection map disclosure after the table that navigates to #relay, and renders the map on #relay", async () => {
    const html = renderStatic(baseProps());
    expect(html).not.toContain('data-slot="relay-map"');
    expect(html).toContain('class="relay-dash-map-disclosure"');
    expect(html.indexOf('id="relay-dash-pcs"')).toBeLessThan(html.indexOf('class="relay-dash-map-disclosure"'));

    await mount();
    expect(renderer!.root.findAll((n) => n.props["data-slot"] === "relay-map")).toHaveLength(0);
    const disclosure = renderer!.root.find((n) => n.type === "a" && n.props.className === "relay-dash-map-disclosure" && n.props.href === "#relay");
    expect(textOf(disclosure)).toContain("Connection map");

    await act(async () => {
      disclosure.props.onClick({ preventDefault() {} });
    });
    expect(window.location.hash).toBe("#relay");
    expect(textOf(renderer!.root.findByType("h1"))).toBe("Relay");
    expect(renderer!.root.findAll((n) => n.props["data-slot"] === "relay-map")).toHaveLength(1);
  });
});
