import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import {
  INSTALLER_COMMAND,
  PLUGIN_COMMANDS,
  RelayShellCardContent,
  TypedDigits,
} from "./RelayShellScreens.tsx";
import { CodeEntry, type RelayShellProps } from "./RelayShell.tsx";

const none = () => {};
const baseProps = (state: RelayShellProps["state"]): RelayShellProps => ({
  state,
  scoped: true,
  iosTab: false,
  onPair: none,
  onRetry: none,
  onCancel: none,
  onBack: none,
  onForget: none,
  onUpdate: none,
  onMatch: none,
  onCodeStart: none,
  onCodeSubmit: none,
  onCodeMatch: none,
});

const render = (node: ReturnType<typeof createElement>): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: node }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

describe("RelayShellScreens", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let copiedText: string[] = [];

  beforeEach(() => {
    copiedText = [];
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    const events = new EventTarget();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    class HTMLElement { isConnected = true; focus(): void {} }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        languages: ["en"],
        userAgent: "Mozilla/5.0",
        maxTouchPoints: 0,
        clipboard: {
          writeText: async (text: string) => { copiedText.push(text); },
        },
      },
    });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        matchMedia,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
        activeElement: new HTMLElement(),
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      },
    });
  });

  afterEach(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  it("applies the system .input class, visible labels, and keeps the uncontrolled DOM input across lookup failures", async () => {
    const codeHtml = render(
      createElement(CodeEntry, {
        failure: "no-pc",
        looking: false,
        onSubmit: none,
        back: createElement("button", { type: "button", className: "btn" }, "Cancel"),
      }),
    );
    expect(codeHtml).toMatch(/<label[^>]*class="relay-shell-field-label"[^>]*for="[^"]+"/);
    expect(codeHtml).toMatch(/<input[^>]*class="input relay-shell-code-input"/);
    expect(codeHtml).toMatch(/<p[^>]*class="account-error"[^>]*role="alert"/);
    expect(codeHtml).toContain("Settings → Devices and PCs → Add a connection → Ovis relay");
    expect(codeHtml).not.toContain("older Ovis");

    const digitsHtml = render(
      createElement(TypedDigits, {
        pc: "Desk PC",
        onSubmit: none,
        cancel: createElement("button", { type: "button", className: "btn" }, "Cancel"),
      }),
    );
    expect(digitsHtml).toMatch(/<label[^>]*class="relay-shell-field-label"/);
    expect(digitsHtml).toMatch(/<input[^>]*class="input relay-shell-code-input"/);

    const compactHtml = render(
      createElement(TypedDigits, {
        pc: "Desk PC",
        compact: true,
        onSubmit: none,
        cancel: createElement("button", { type: "button", className: "btn" }, "Cancel"),
      }),
    );
    expect(compactHtml).not.toContain("<h1");
    expect(compactHtml).not.toContain("relay-shell-copy");

    const submitted: string[] = [];
    const fieldMock = { value: "7K3QD-M2XHA" };
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          createElement(SettingsProvider, {
            children: createElement(CodeEntry, {
              failure: null,
              looking: false,
              onSubmit: (code) => submitted.push(code),
              back: createElement("button", { type: "button", className: "btn" }, "Cancel"),
            }),
          }),
        );
      });
      const inputBefore = renderer!.root.findByType("input");
      const form = renderer!.root.findByType("form");
      await act(async () => {
        form.props.onSubmit({
          preventDefault() {},
          currentTarget: { elements: { namedItem: () => fieldMock } },
        });
      });
      expect(submitted).toEqual(["7K3QD-M2XHA"]);
      expect(fieldMock.value).toBe("7K3QD-M2XHA");

      await act(async () => {
        renderer!.update(
          createElement(SettingsProvider, {
            children: createElement(CodeEntry, {
              failure: null,
              looking: true,
              onSubmit: (code) => submitted.push(code),
              back: createElement("button", { type: "button", className: "btn" }, "Cancel"),
            }),
          }),
        );
      });
      const inputDuring = renderer!.root.findByType("input");
      expect(inputDuring).toBe(inputBefore);

      await act(async () => {
        renderer!.update(
          createElement(SettingsProvider, {
            children: createElement(CodeEntry, {
              failure: "wrong",
              looking: false,
              onSubmit: (code) => submitted.push(code),
              back: createElement("button", { type: "button", className: "btn" }, "Cancel"),
            }),
          }),
        );
      });
      const inputAfter = renderer!.root.findByType("input");
      expect(inputAfter).toBe(inputBefore);
      expect(fieldMock.value).toBe("7K3QD-M2XHA");
    } finally {
      await act(async () => { renderer?.unmount(); });
    }
  });

  it("renders Copy buttons for both manual update command blocks and updates to Copied on click", async () => {
    let renderer: ReactTestRenderer | undefined;
    try {
      const shown = baseProps({
        kind: "outdated",
        name: "Desk PC",
        serverVersion: "0.4.0",
        minVersion: "0.5.0",
        update: { phase: "manual" },
      });
      await act(async () => {
        renderer = create(
          createElement(SettingsProvider, {
            children: createElement(RelayShellCardContent, {
              props: shown,
              view: null,
              signInFirst: false,
              saved: 0,
              addingPc: false,
              setSignedOutView: none,
              setAddingPc: none,
            }),
          }),
        );
      });
      const copyBtns = renderer!.root.findAll(
        (n) => n.type === "button" && textOf(n).trim() === "Copy",
      );
      expect(copyBtns).toHaveLength(2);
      await act(async () => {
        copyBtns[0]!.props.onClick();
      });
      expect(copiedText).toEqual([INSTALLER_COMMAND]);
      expect(
        renderer!.root.findAll((n) => n.type === "button" && textOf(n).trim() === "Copied"),
      ).toHaveLength(1);

      await act(async () => {
        copyBtns[1]!.props.onClick();
      });
      expect(copiedText).toEqual([INSTALLER_COMMAND, PLUGIN_COMMANDS]);
    } finally {
      await act(async () => { renderer?.unmount(); });
    }
  });

  it("keeps the sign-in column mounted during signing-in with the busy provider marked and peers disabled", () => {
    const html = render(
      createElement(RelayShellCardContent, {
        props: {
          ...baseProps({ kind: "empty", account: { kind: "signing-in", provider: "google" } }),
          scoped: false,
          onSignIn: none,
          accountProviders: ["github", "google", "apple"],
        },
        view: "sign-in",
        signInFirst: true,
        saved: 2,
        addingPc: false,
        setSignedOutView: none,
        setAddingPc: none,
      }),
    );
    expect(html).toContain("Sign in to Ovis");
    expect(html).toContain('data-provider="google" aria-busy="true" disabled=""');
    expect(html).toContain('class="btn account-continue-saved" disabled=""');
    expect(html).toContain('data-action="pair-qr" disabled=""');
  });

  describe("the confirm before a link's PC is paired with", () => {
    const offer = { v: 1 as const, server_id: "0123456789abcdef0123456789abcdef", server_public_key: "key", relay: "wss://relay.ovis.sh", name: "Desk PC" };
    const confirm = (account?: "checking" | "unlisted" | "listed", pressed?: "unlisted" | "listed" | "own"): string => render(createElement(RelayShellCardContent, {
      props: baseProps({ kind: "confirm", offer, ...(account ? { account } : {}), ...(pressed ? { pressed } : {}) }),
      view: null, signInFirst: false, saved: 0, addingPc: false, setSignedOutView: none, setAddingPc: none,
    }));
    const pcId = '<span class="key-id" role="group" aria-label="ID of the PC this link names"><span class="key-id-group">0123</span>';

    it("signed out, pairs with a key of this device's own and says nothing of an account", () => {
      const html = confirm();
      expect(html).toContain("Pair with Desk PC?");
      expect(html).toContain("This device gets a key of its own for Desk PC.");
      expect(html).toContain('<button type="button" class="btn btn-primary">Pair</button>');
      expect(html).not.toContain("account");
      expect(html).not.toContain(pcId);
    });

    it("signed in with a PC the account does not list, says the pairing adds it to the account and shows the PC's ID", () => {
      const html = confirm("unlisted");
      expect(html).toMatch(/Add Desk PC<\/span> <span class="relay-shell-hero-quiet">to your account\?/);
      expect(html).toContain("Pairing adds this PC to your Ovis account, so every device of your account can open it. Pair only with a PC you are setting up yourself.");
      expect(html).toContain(pcId);
      expect(html).toContain('<button type="button" class="btn btn-primary">Add and pair</button>');
      expect(html).toContain(">Not now</button>");
      expect(html).not.toContain("Pair with Desk PC?");
      expect(html).not.toContain("a key of its own");
    });

    it("signed in with a PC the account lists, says this device joins it with the account's key", () => {
      const html = confirm("listed");
      expect(html).toContain("Pair with Desk PC?");
      expect(html).toContain("This device joins Desk PC with your account&#x27;s key. The PC lists it under Settings → Devices and PCs, where it can be removed.");
      expect(html).toContain('<button type="button" class="btn btn-primary">Pair</button>');
      expect(html).not.toContain("a key of its own");
      expect(html).not.toMatch(/Add Desk PC<\/span> <span class="relay-shell-hero-quiet">to your account\?/);
    });

    it("until the sign-in is read, claims neither, says it is checking and takes no confirmation", () => {
      const html = confirm("checking");
      expect(html).toContain("Pair with Desk PC?");
      expect(html).toContain('<button type="button" class="btn btn-primary" disabled="" aria-busy="true">Pair</button>');
      expect(html).toContain('<p class="relay-shell-detail" role="status">Checking your account…</p>');
      expect(html).not.toContain("a key of its own");
      expect(html).not.toContain("your account&#x27;s key");
      expect(html).not.toContain("to your account");
    });

    it("keeps the wording a press was made on while the press is checked, with its button held", () => {
      const adds = confirm("checking", "unlisted");
      expect(adds).toMatch(/Add Desk PC<\/span> <span class="relay-shell-hero-quiet">to your account\?/);
      expect(adds).toContain("Pairing adds this PC to your Ovis account");
      expect(adds).toContain(pcId);
      expect(adds).toContain('<button type="button" class="btn btn-primary" disabled="" aria-busy="true">Add and pair</button>');
      expect(adds).toContain('<p class="relay-shell-detail" role="status">Checking your account…</p>');
      expect(adds).not.toContain("Pair with Desk PC?");
      const joins = confirm("checking", "listed");
      expect(joins).toContain("Pair with Desk PC?");
      expect(joins).toContain("This device joins Desk PC with your account&#x27;s key.");
      expect(joins).toContain('disabled="" aria-busy="true">Pair</button>');
      expect(joins).toContain("Checking your account…");
      const own = confirm("checking", "own");
      expect(own).toContain("This device gets a key of its own for Desk PC.");
      expect(own).toContain('disabled="" aria-busy="true">Pair</button>');
      expect(own).not.toContain("account");
    });
  });

  it("clears the uncontrolled TypedDigits input when a fresh challenge number arrives", async () => {
    const fieldNode = { value: "123456" };
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          createElement(SettingsProvider, {
            children: createElement(TypedDigits, {
              pc: "Desk PC",
              challenge: 1,
              onSubmit: none,
              cancel: createElement("button", { type: "button", className: "btn" }, "Cancel"),
            }),
          }),
          {
            createNodeMock: (el) => (el.type === "input" ? fieldNode : null),
          },
        );
      });
      expect(fieldNode.value).toBe("123456");

      await act(async () => {
        renderer!.update(
          createElement(SettingsProvider, {
            children: createElement(TypedDigits, {
              pc: "Desk PC",
              challenge: 2,
              onSubmit: none,
              cancel: createElement("button", { type: "button", className: "btn" }, "Cancel"),
            }),
          }),
        );
      });
      expect(fieldNode.value).toBe("");
    } finally {
      await act(async () => { renderer?.unmount(); });
    }
  });
  it("offers the account service's providers on a marked pairing's sign-in screen, and says how that sign-in went", () => {
    const failed = { kind: "failed" as const, failure: "sign-in-first" as const, name: "Desk", detail: null, server_id: "a".repeat(32) };
    const card = (state: RelayShellProps["state"], signIn: boolean) => render(createElement(RelayShellCardContent, {
      props: { ...baseProps(state), ...(signIn ? { onSignIn: none, accountProviders: ["github", "google"] as const } : {}) },
      view: null, signInFirst: false, saved: 0, addingPc: false, setSignedOutView: none, setAddingPc: none,
    }));
    const offered = card(failed, true);
    expect(offered).toContain("Your PCs, anywhere.");
    expect(offered).toContain("Sign in to your Ovis account");
    expect(offered).not.toContain("then scan the QR code again");
    // every way in weighs the same: no provider is the filled one
    expect([...offered.matchAll(/class="([^"]*)" data-provider="([a-z]+)"/g)].map(([, classes = "", provider]) => [provider, classes.includes("btn-primary")])).toEqual([["github", false], ["google", false]]);
    // each button names only its provider; the title already says what they are for
    expect(offered).toContain("</svg>GitHub</button>");
    expect(offered).toContain("</svg>Google</button>");
    expect(offered).toMatch(/you agree to the <a href="https:\/\/ovis\.sh\/privacy\/"[^>]*>Privacy Policy<\/a>\./);
    // a page without an account service has no sign-in to offer: the sentence that says where to go stays
    const withoutService = card(failed, false);
    expect(withoutService).toContain("Sign in on this device, then scan the QR code again.");
    expect(withoutService).not.toContain("data-provider");
    const busy = card({ ...failed, account: { kind: "signing-in", provider: "google" } }, true);
    expect(busy).toMatch(/data-provider="google"[^>]*aria-busy="true"/);
    const refused = card({ ...failed, account: { kind: "signed-out", error: "The sign-in was cancelled.", provider: "google" } }, true);
    expect(refused).toContain("The sign-in was cancelled.");
    expect(refused).toContain('data-action="retry-signin"');
    const expired = card({ kind: "failed", failure: "scan-expired", name: "Desk", detail: null }, true);
    expect(expired).toContain("The QR code ran out while you signed in");
    expect(expired).toContain("Show a new QR code on Desk and scan it.");
    expect(expired).not.toContain("data-provider");
  });
  it("keeps the PC's ID of an Add and pair confirm folded under Details", () => {
    const offer = { v: 1 as const, server_id: "a3f9c2e17b4d5a6c8e9f0b1d2c3a4e5f", server_public_key: "key", relay: "wss://relay.example", name: "Desk", code: "123456" };
    const confirm = (account: "unlisted" | "listed") => render(createElement(RelayShellCardContent, {
      props: baseProps({ kind: "confirm", offer, account }), view: null, signInFirst: false, saved: 0, addingPc: false, setSignedOutView: none, setAddingPc: none,
    }));
    const adding = confirm("unlisted");
    expect(adding).toContain("Add Desk");
    expect(adding).toContain("to your account?");
    expect(adding).toMatch(/<dt>PC<\/dt><dd>Desk<\/dd><dt>Account<\/dt><dd>Your Ovis account<\/dd>/);
    expect(adding).toMatch(/<details class="relay-shell-key-details"><summary>Details<\/summary><p class="relay-shell-copy">[^<]*<\/p><p class="relay-shell-code-id">/);
    expect(adding).not.toMatch(/<details[^>]*open/);
    expect(adding).toContain("a3f9");
    expect(confirm("listed")).not.toContain("relay-shell-key-details");
  });
});
