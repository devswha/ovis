import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { decodeOffer } from "../../../shared/relay-offer.ts";
import { generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { memoryAccountStore } from "../account/store.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { ShellDeviceStore } from "./device.ts";
import { mountRelayShell } from "./shell.tsx";
import { createShellTestPage } from "./shell.test.tsx";
import type { RelayShellMount } from "./shellState.ts";

const SERVICE = "https://account.ovis.sh";

describe("a PC's own page on a device that has no pairing for it", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
  afterEach(() => { setTransport(nativeTransport); browser.dispose(); });

  const land = async (listed: boolean) => {
    const identity = generateKeyPair();
    const serverId = deriveServerId(identity.publicKey);
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    const now = Date.now();
    const pcs = listed ? [{ server_id: serverId, label: "Desk", relay: "wss://relay.ovis.sh", public_key: Buffer.from(identity.publicKey).toString("hex"),
      added_at: new Date(now - 3_600_000).toISOString(), last_seen_at: new Date(now - 30_000).toISOString() }] : [];
    const paths: string[] = [];
    const drawn: RelayShellProps[] = [];
    const render = (node: ReactNode): void => {
      if (!isValidElement<{ readonly children?: ReactNode }>(node)) throw new TypeError("Missing shell element");
      if (node.type === RelayShell && isValidElement<RelayShellProps>(node)) { drawn.push(node.props); return; }
      render(node.props.children);
    };
    const store: ShellDeviceStore = {
      get: async () => undefined, list: async () => [], remove: async () => {}, removeRow: async () => false,
      update: async () => { throw new TypeError("Pairing has not been approved by the PC"); },
    };
    const compared = Promise.withResolvers<void>();
    const mount: RelayShellMount = {
      container: Object.create(null), entryUrl: `https://app.ovis.sh/s/${serverId}/`, shellVersion: "1.0.0",
      store, label: "Phone", accountStore, accountService: SERVICE,
      accountFetch: async () => Response.json({ pcs }),
      createRoot: () => ({ render, unmount() {} }),
      renderApp: () => { throw new TypeError("Pairing has not finished"); },
      navigate: (path) => { paths.push(path); },
      open: async (_offer, options) => {
        if (!options?.compare) throw new TypeError("A join must compare a number");
        await options.compare("123456");
        compared.resolve();
        return await new Promise<never>(() => {});
      },
    };
    await mountRelayShell(mount);
    return { serverId, paths, drawn, mount, compared: compared.promise };
  };

  it("asks to join a PC of the account that needs this device approved, on that PC's page and with no list of PCs", async () => {
    const { serverId, paths, drawn, mount, compared } = await land(true);
    expect(drawn.map((props) => props.state.kind).filter((kind) => kind === "list" || kind === "empty")).toEqual([]);
    expect(paths).toHaveLength(1);
    const link = new URL(paths[0]!, mount.entryUrl);
    expect(link.pathname).toBe(`/s/${serverId}/`);
    expect(decodeOffer(link.href)?.server_id).toBe(serverId);
    expect(JSON.parse(browser.sessionStore.get("ovis-add-pc-sheet") ?? "null")).toMatchObject({ mode: "join", server_id: serverId, alone: true });

    const joined: RelayShellProps[] = [];
    await mountRelayShell({ ...mount, entryUrl: link.href, createRoot: () => ({ render: (node: ReactNode) => {
      const find = (child: ReactNode): void => {
        if (!isValidElement<{ readonly children?: ReactNode }>(child)) return;
        if (child.type === RelayShell && isValidElement<RelayShellProps>(child)) { joined.push(child.props); return; }
        find(child.props.children);
      };
      find(node);
    }, unmount() {} }) });
    await compared;
    const last = joined.at(-1)!;
    expect(last.state).toMatchObject({ kind: "compare", digits: "123456", confirmed: true, alone: true });
    expect(last.sheetJoin).toMatchObject({ mode: "join", server_id: serverId, alone: true });
    expect("continuedAccount" in last).toBe(false);
  });

  it("keeps saying to scan the PC's code when the account does not list that PC", async () => {
    const { paths, drawn } = await land(false);
    expect(paths).toEqual([]);
    expect(drawn.at(-1)?.state.kind).toBe("empty");
  });
});
