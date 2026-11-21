import { useEffect, useState, type ReactNode } from "react";
import { QrCode } from "lucide-react";

import type { AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { callNative, hasNativePlugin } from "../lib/nativeApp.ts";
import { tailnetHost } from "../lib/phone.ts";
import { AccountJoinRequests } from "./AccountJoinRequests.tsx";
import { NewPcNotices } from "./NewPcNotices.tsx";
import { UnconfirmedPcNotices } from "./UnconfirmedPcNotices.tsx";
import { AddressForm, canScanQr, SavedPcs, scanQr, useAddressOpen, Way, type AddressOpen, type SavedPc } from "./RelayAddPc.tsx";

type ConnectWay = "relay" | "tailscale" | "direct";
const CONNECT_WAYS: readonly ConnectWay[] = ["relay", "tailscale", "direct"];

/** The phone app's shell plugin (app/android HerdrShellPlugin): the PCs this phone opened, and whether Tailscale is on. */
const SHELL = "HerdrShell";

export interface TailnetPc { readonly origin: string; readonly host: string; readonly name: string }

/**
 * The PCs this phone opened at a Tailscale address, which the Tailscale tab offers again (app/web/shell.js `tailnetPcs`,
 * the phone app's own list): a phone has no list of its tailnet's machines, only the ones opened here. `saved` and
 * `names` as HerdrShell's getState gives them; a MagicDNS name goes by its first label, an address by itself.
 */
export function tailnetPcs(saved: readonly string[], names: Readonly<Record<string, string>>): TailnetPc[] {
  return saved.flatMap((origin) => {
    let url: URL;
    try { url = new URL(origin); } catch { return []; }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!tailnetHost(host)) return [];
    const short = host.toLowerCase().endsWith(".ts.net") ? host.split(".")[0]! : url.host;
    return [{ origin, host: url.host, name: names[origin] || short }];
  });
}

/** Scan a QR code, where the phone app can scan: what it read opens as a typed address would (`open`). */
function ScanWay({ open, failed }: { readonly open: AddressOpen; readonly failed: (cause: unknown) => void }) {
  const t = useT();
  return <Way icon={QrCode} title={t("Scan a QR code")} sub={t("The QR on the PC's screen")} action="scan-qr" onClick={() => { open.setError(null); scanQr(t, open.take, failed); }} />;
}

function OpenError({ open }: { readonly open: AddressOpen }) {
  return open.error === null ? null : <p className="account-error" role="alert">{open.error}</p>;
}

/**
 * The Ovis relay tab signed in: a PC joins the account from its own Ovis, signed in with the same account, so this
 * says so; a PC in no account pairs by its QR code where the phone app can scan, or by its code in a browser.
 */
export function AccountRelayPanel({ onCodeStart, onSignInAgain }: { readonly onCodeStart: () => void; readonly onSignInAgain?: ((provider: AccountProvider) => void) | undefined }) {
  const t = useT();
  const open = useAddressOpen();
  return (
    <>
      <NewPcNotices />
      <AccountJoinRequests />
      <UnconfirmedPcNotices tellConfirmed={false} onSignInAgain={onSignInAgain} />
      <p className="relay-shell-copy">{t("Turn on Ovis on the PC and sign in with the same account.")}</p>
      {canScanQr()
        ? <ScanWay open={open} failed={onCodeStart} />
        : <button type="button" className="btn btn-ghost account-link connect-start-code" data-action="add-code" onClick={onCodeStart}>{t("Pair with a code")}</button>}
      <OpenError open={open} />
    </>
  );
}

/**
 * The Tailscale tab: a PC's Tailscale address in one field. In the phone app also the PCs this phone opened on the
 * tailnet, each with Connect, and its QR scan; with Tailscale off on the phone nothing here would open, so one line and
 * Open Tailscale alone, checked again when the app comes back (from Tailscale). An app that cannot tell draws it as on.
 */
function TailscalePanel() {
  const t = useT();
  const open = useAddressOpen();
  const native = hasNativePlugin(SHELL);
  const [on, setOn] = useState(true);
  const [pcs, setPcs] = useState<TailnetPc[]>([]);
  useEffect(() => {
    if (!native) return;
    let live = true;
    const check = (): void => {
      // an Android build without the check: as on
      callNative<{ on?: boolean }>(SHELL, "tailscale").then((answer) => { if (live) setOn(answer.on !== false); }, () => undefined);
    };
    check();
    callNative<{ saved?: string[]; names?: Record<string, string> }>(SHELL, "getState").then((state) => { if (live) setPcs(tailnetPcs(state.saved ?? [], state.names ?? {})); }, () => undefined);
    const visible = (): void => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { live = false; document.removeEventListener("visibilitychange", visible); };
  }, [native]);
  if (!on) {
    return (
      <div className="connect-start-panel" data-tab-panel="tailscale">
        <p className="relay-shell-copy">{t("Turn on Tailscale to connect")}</p>
        <button type="button" className="btn btn-primary" onClick={() => { open.setError(null); callNative(SHELL, "openTailscale").catch(open.failed); }}>{t("Open Tailscale")}</button>
        <OpenError open={open} />
      </div>
    );
  }
  return (
    <div className="connect-start-panel" data-tab-panel="tailscale">
      {pcs.length > 0 && (
        <section className="connect-start-tailnet">
          <h2 className="relay-add-saved-title">{t("PCs on Tailscale")}</h2>
          <ul>
            {pcs.map((pc) => (
              <li key={pc.origin} data-tailnet-pc={pc.origin}>
                <span className="connect-start-tailnet-text"><span className="relay-add-saved-name">{pc.name}</span>{pc.host !== pc.name && <span className="relay-add-saved-note">{pc.host}</span>}</span>
                <button type="button" className="btn" onClick={() => open.take(new URL(pc.origin))}>{t("Connect")}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <AddressForm open={open} labelShown label={t("Tailscale address")} placeholder="my-pc.tailnet.ts.net" submit={t("Connect")} />
      <p className="relay-shell-detail">{t("The phone needs the Tailscale app turned on too.")}</p>
      {canScanQr() && <ScanWay open={open} failed={open.failed} />}
      <OpenError open={open} />
    </div>
  );
}

/** The Direct tab: a PC's address on this network in one field, and its QR scan where the phone app can scan. */
function DirectPanel() {
  const t = useT();
  const open = useAddressOpen();
  return (
    <div className="connect-start-panel" data-tab-panel="direct">
      <AddressForm open={open} labelShown label={t("PC address")} placeholder="192.168.0.10:7317" submit={t("Connect")} />
      {canScanQr() && <ScanWay open={open} failed={open.failed} />}
      <OpenError open={open} />
    </div>
  );
}

/**
 * The hosted front page: the desktop's Add a connection tabs in its order, the Ovis relay chosen, so nothing asks for a
 * sign-in first. `relay`: that tab's way in (signed out its sign-in, signed in what to do on the PC); `menu`: the
 * account's menu at the top, signed in. A browser cannot see the tailnet or the Wi-Fi, so Tailscale and Direct each take
 * a PC's address (RelayAddPc's AddressForm, which opens that PC's own Ovis); the phone app adds what it knows.
 */
export function ConnectStart({ relay, devices, menu }: { readonly relay: ReactNode; readonly devices: readonly SavedPc[]; readonly menu?: ReactNode }) {
  const t = useT();
  const [way, setWay] = useState<ConnectWay>("relay");
  const label: Record<ConnectWay, string> = { relay: t("Ovis relay"), tailscale: "Tailscale", direct: t("Direct") };
  const title = <h1 className="relay-shell-title connect-start-title">{t("Connect a PC")}</h1>;
  return (
    <>
      {menu === undefined ? title : <div className="connect-start-head">{title}{menu}</div>}
      <div className="segmented connect-start-tabs" role="group" aria-label={t("How to connect")}>
        {CONNECT_WAYS.map((each) => <button key={each} type="button" aria-pressed={way === each} data-tab={each} onClick={() => setWay(each)}>{label[each]}</button>)}
      </div>
      {way === "relay" && <div className="connect-start-panel" data-tab-panel="relay">{relay}</div>}
      {way === "tailscale" && <TailscalePanel />}
      {way === "direct" && <DirectPanel />}
      {devices.length > 0 && <SavedPcs devices={devices} />}
    </>
  );
}
