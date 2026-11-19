import "./RelayAddPc.css";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Globe, QrCode, SquareTerminal, type LucideIcon } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { callNative, hasNativePlugin } from "../lib/nativeApp.ts";
import { serverIdOfPath, serverScopePath } from "../lib/shellMode.ts";
import { SheepMascot } from "./SheepMascot.tsx";

/** The phone app's QR scanner (@capacitor/barcode-scanner, app/package.json) and its SSH screen (Android's OvisSsh). */
const SCANNER = "CapacitorBarcodeScanner";
const SSH = "OvisSsh";

/**
 * An address typed as people write it: `my-pc.tailnet.ts.net`, `192.168.0.12:7421` or a whole URL. A bare IPv4
 * address gets http (a home network's Ovis has no certificate), any other name https; null for anything else.
 */
export function addressOf(text: string): URL | null {
  let value = text.trim();
  if (value === "") return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(value) ? "http://" : "https://") + value;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" ? url : null;
  } catch { return null; }
}

/** Opens a PC's address: the phone app checks it is Ovis first (HerdrShell.open, app/web/connect.js); a browser goes there. */
async function openAddress(url: URL): Promise<void> {
  if (hasNativePlugin("HerdrShell")) await callNative("HerdrShell", "open", { url: url.href, check: true });
  else window.location.assign(url.href);
}

function Way({ icon: Icon, title, sub, onClick, action }: { readonly icon: LucideIcon; readonly title: string; readonly sub: string; readonly onClick: () => void; readonly action: string }) {
  return (
    <button type="button" className="relay-add-way" data-action={action} onClick={onClick}>
      <span className="relay-add-way-icon"><Icon aria-hidden="true" /></span>
      <span className="relay-add-way-text"><span className="relay-add-way-title">{title}</span><span className="relay-add-way-sub">{sub}</span></span>
      <ChevronRight className="relay-add-way-chevron" aria-hidden="true" />
    </button>
  );
}

/**
 * Add a PC, the one screen behind "Start without signing in" and the app's Add a PC: scan the PC's QR code, enter an
 * address on Tailscale or Wi-Fi, or SSH where the phone app can, then the PCs this device paired before. `qr`: the
 * screen that says where the QR code is and offers a code, for a page with no scanner of its own (a browser).
 */
export function RelayAddPc({ onBack, devices, qr }: {
  readonly onBack?: (() => void) | undefined;
  readonly devices: readonly { readonly server_id: string; readonly name?: string | undefined }[];
  readonly qr: (back: () => void) => ReactNode;
}) {
  const t = useT(), fieldId = useId();
  const [step, setStep] = useState<"ways" | "address" | "qr">("ways");
  const [error, setError] = useState<string | null>(null);
  const failed = (cause: unknown): void => { setError(cause instanceof Error ? cause.message : String(cause)); };
  const go = (next: "ways" | "address" | "qr"): void => { setError(null); setStep(next); };
  const scan = (): void => {
    if (!hasNativePlugin(SCANNER)) { go("qr"); return; }
    setError(null);
    // the plugin's own JS fills these defaults; the page calls the bridge without it (app/web/connect.js)
    void callNative<{ ScanResult?: string }>(SCANNER, "scanBarcode", { hint: 0, scanInstructions: t("Point at the QR code on the PC's screen"), scanButton: false, scanText: " ", cameraDirection: 1, scanOrientation: 3 }).then((result) => {
      if (!result.ScanResult) return;
      const url = addressOf(result.ScanResult);
      // a pairing link of this app opens here, at its PC's page; another address is a PC's own; anything else is said
      if (url !== null && url.origin === window.location.origin && serverIdOfPath(url.pathname) !== null && url.hash.startsWith("#offer=")) window.location.assign(url.href);
      else if (url !== null && url.origin !== window.location.origin) return openAddress(url);
      else setError(t("That is not an http or https address."));
    }).catch(failed);
  };
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const url = addressOf((event.currentTarget.elements.namedItem("address") as HTMLInputElement).value);
    if (url === null) { setError(t("That is not an http or https address.")); return; }
    setError(null);
    openAddress(url).catch(failed);
  };
  const back = step === "ways" ? onBack : () => go("ways");
  if (step === "qr") return <>{qr(() => go("ways"))}</>;
  return (
    <div className="relay-add" data-add-step={step}>
      {back && <button type="button" className="relay-add-back" aria-label={t("Back")} onClick={back}><ChevronLeft aria-hidden="true" /></button>}
      {step === "ways" ? (
        <>
          <SheepMascot screen="header" size={56} badge />
          <h1 className="relay-add-title">{t("Add a PC|screen")}</h1>
          <div className="relay-add-ways">
            <Way icon={QrCode} title={t("Scan a QR code")} sub={t("The QR on the PC's screen")} action="add-qr" onClick={scan} />
            <Way icon={Globe} title={t("Enter an address")} sub="Tailscale · Wi-Fi" action="add-address" onClick={() => go("address")} />
            {/* only where the phone app can reach a PC over SSH itself: a page without it draws no way it cannot take */}
            {hasNativePlugin(SSH) && <Way icon={SquareTerminal} title="SSH" sub="user@host" action="add-ssh" onClick={() => { setError(null); callNative(SSH, "add").catch(failed); }} />}
          </div>
          {devices.length > 0 && (
            <section className="relay-add-saved">
              <h2 className="relay-add-saved-title">{t("Your PCs")}</h2>
              <ul>
                {devices.map((device) => (
                  <li key={device.server_id}><a className="relay-add-saved-pc" href={serverScopePath(device.server_id)}>{device.name ?? t("Unnamed PC")}<ChevronRight aria-hidden="true" /></a></li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        <>
          <h1 className="relay-add-title">{t("Enter an address")}</h1>
          <form className="relay-add-form" onSubmit={submit} noValidate>
            <input id={fieldId} name="address" className="input" type="url" inputMode="url" aria-label={t("PC address")} placeholder="https://my-pc.tailnet.ts.net" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="url" autoFocus />
            <button type="submit" className="btn btn-primary">{t("Open")}</button>
          </form>
        </>
      )}
      {error !== null && <p className="account-error" role="alert">{error}</p>}
    </div>
  );
}
