import { expect, it } from "bun:test";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { memoryAccountStore } from "../account/store.ts";
import { SettingsProvider } from "../settings.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { ShellDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";
import { mountRelayShell } from "./shell.tsx";
import type { RelayShellMount } from "./shellState.ts";

it("T71, P11: a code pairing shows the pending fingerprint until the attempt is cancelled", async () => {
  const browser = createShellTestPage();
  browser.setVisibility("hidden");
  const pc = generateKeyPair();
  const app = "https://app.ovis.sh";
  const entryUrl = encodeOffer({
    v: 1, server_id: deriveServerId(pc.publicKey), server_public_key: exportPublicKey(pc.publicKey),
    relay: "wss://relay.ovis.sh", code: "123456", name: "Desk",
  }, app);
  const store: ShellDeviceStore = {
    get: async () => undefined, list: async () => [], remove: async () => {}, removeRow: async () => false,
    update: async (_id, change) => change(undefined),
  };
  let props: RelayShellProps | undefined;
  const render = (node: ReactNode): void => {
    if (!isValidElement<{ readonly children?: ReactNode }>(node)) throw new TypeError("Missing shell");
    if (node.type === RelayShell && isValidElement<RelayShellProps>(node)) { props = node.props; return; }
    render(node.props.children);
  };
  const current = (): RelayShellProps => {
    if (props === undefined) throw new TypeError("Missing shell props");
    return props;
  };
  const markup = () => renderToStaticMarkup(createElement(SettingsProvider, null, createElement(RelayShell, current())));
  const opening = Promise.withResolvers<Parameters<NonNullable<RelayShellMount["open"]>>[1]>();
  try {
    await mountRelayShell({
      entryUrl, container: Object.create(null), store, shellVersion: "1.0.0", label: "Phone",
      accountStore: memoryAccountStore(), accountProviders: [],
      createRoot: () => ({ render, unmount() {} }),
      renderApp: () => { throw new TypeError("The PC has not approved the key"); },
      pendingPush: { get: async () => undefined, clear: async () => {} },
      navigate() {},
      open: async (_offer, options) => {
        opening.resolve(options);
        await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new DOMException("Pairing cancelled", "AbortError");
      },
    });
    current().onPair();
    const options = await opening.promise;
    const fingerprint = "7RJ5-P9C2";
    expect(markup()).not.toContain(fingerprint);
    options?.keyProof?.(fingerprint);
    expect(markup()).toContain(fingerprint);
    current().onCancel();
    options?.keyProof?.(fingerprint);
    expect(markup()).not.toContain(fingerprint);
  } finally {
    props?.onCancel();
    setTransport(nativeTransport);
    browser.dispose();
  }
});
