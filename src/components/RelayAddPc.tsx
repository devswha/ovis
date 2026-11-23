import "./RelayAddPc.css";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";

import { useT, type Translate } from "../lib/i18n.ts";
import { callNative, hasNativeMethod, hasNativePlugin } from "../lib/nativeApp.ts";
import { ACCOUNT_PROVIDERS } from "../lib/account/store.ts";
import { isLoopbackHost, tailnetHost } from "../lib/phone.ts";
import { serverIdOfPath, serverScopePath } from "../lib/shellMode.ts";

/** The phone app's QR scanner (@capacitor/barcode-scanner, app/package.json) and its SSH screen (Android's OvisSsh). */
const SCANNER = "CapacitorBarcodeScanner";
const SSH = "OvisSsh";

const SSH_TARGET = /^(?:ssh:\/\/)?([^\s@/:]+)@([^\s@/:[\]]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?\/?$/i;

/**
 * An SSH login typed where an address goes, `user@host` or `user@host:port` (or `ssh://` with them), as the app's own
 * SSH field reads it (app/web/shell.js `sshOrAddress`): its text as `user@host[:port]`, or null for anything else.
 */
export function sshTarget(text: string): string | null {
  const found = SSH_TARGET.exec(text.trim());
  if (found === null) return null;
  const port = found[3] === undefined ? 22 : Number(found[3]);
  if (port < 1 || port > 65535) return null;
  return `${found[1]}@${found[2]}${port === 22 ? "" : `:${port}`}`;
}

/**
 * Whether this page can hand SSH to the phone app: a PC page (the hosted app's included) never adds an SSH PC itself
 * (OvisSsh answers only the app's own pages), so it asks the app to open its own connect screen with the login filled
 * in (HerdrShell openSshSetup), where the person adds it. An app without that, and a browser, have no SSH here.
 */
export function sshHandoff(): boolean {
  return hasNativePlugin(SSH) && hasNativeMethod("HerdrShell", "openSshSetup");
}

/** Opens the app's own SSH screen, `target` (`user@host[:port]`) filled in, or empty to type one there. */
export function openSshSetup(target: string): Promise<unknown> {
  return callNative("HerdrShell", "openSshSetup", { target });
}

/**
 * An address typed as people write it: `my-pc.tailnet.ts.net`, `192.168.0.12:7421` or a whole URL. A bare IPv4
 * address gets http (a home network's Ovis has no certificate), any other name https; null for anything else.
 */
export function addressOf(text: string): URL | null {
  let value = text.trim();
  // a scheme without its slashes (`http:/pc.local`) is a typo, not a host named after the scheme
  if (value === "" || /^[a-z][a-z0-9+.-]*:(?!\/\/|\d)/i.test(value)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(value) ? "http://" : "https://") + value;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" ? url : null;
  } catch { return null; }
}

/**
 * Whether `hostname` (a URL's) is this device, a home network's or a tailnet's, which opens only from inside it, judged by
 * the name alone (the phone app's own rule, app/web/shell.js `homeHost`): a private or link-local IP, a Tailscale address,
 * a one-word name or a name under .local, .lan, .home.arpa or .internal. Any other name is a public server.
 */
function homeHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host.endsWith(".ts.net") || host.startsWith("fd7a:115c:a1e0:")) return true;
  const ipv4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(":")) return /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return !host.includes(".") || /\.(local|lan|home\.arpa|internal)$/.test(host);
}

/**
 * Whether opening `url` would send a pairing code and everything typed across the internet unencrypted: plain http to a
 * host that does not look like this device's, a home network's or a tailnet's (the phone app's own rule, `publicHttp`).
 */
export function publicHttp(url: URL): boolean {
  return url.protocol === "http:" && !homeHost(url.hostname);
}

/** how long the Android app asks an address whether it is Ovis before it gives up (PCStore.ANSWER_SECONDS) */
const ANSWER_SECONDS = 20;

/**
 * Why the phone app could not open `url`, from the reason its check gave (`code`, Android's PCStore.check; app/web/shell.js
 * `openFailure` says the same): nothing for a Cancel, otherwise what went wrong and what to do, with Tailscale's own hint
 * for an address that opens only while Tailscale is on. `message` is the app's own words, used only where no reason fits.
 */
export function openFailureText(t: Translate, url: URL, code: string | undefined, message: string): string {
  const host = url.host;
  const tailscale = tailnetHost(url.hostname.replace(/^\[|\]$/g, "")) ? ` ${t("This is a Tailscale address, and Tailscale may be off on this phone: turn it on in the Tailscale app.")}` : "";
  switch (code) {
    case "cancelled": return "";
    case "not-ovis": return t("{host} answered{status}, but it is not Ovis: another web server, or herdr itself, which the app cannot open. Open the address Ovis shows under Settings → Devices and PCs → Add a connection on the PC.", { host, status: /^HTTP \d{3}$/.test(message) ? ` (${message})` : "" });
    case "refused": {
      const said = t("{host} refused the connection: nothing listens there. Ovis has to run on the PC (herdr alone is not enough), and by default it listens only on the PC itself (127.0.0.1). Open the address Ovis shows under Settings → Devices and PCs → Add a connection on the PC.", { host });
      return isLoopbackHost(url.hostname) ? `${said} ${t("On a phone, localhost and 127.0.0.1 are the phone itself, not your PC.")}` : said;
    }
    case "timeout": return (homeHost(url.hostname)
      ? t("{host} did not answer within {seconds} seconds. The PC may be off, or out of this phone's reach: a home network address does not open over mobile data or another Wi-Fi, and a firewall on the PC can block the port.", { host, seconds: ANSWER_SECONDS })
      : t("Nothing came back from {host} within {seconds} seconds. The server may be down, or this phone's connection (or a VPN on it) may not reach it.", { host, seconds: ANSWER_SECONDS })) + tailscale;
    case "unknown-host": return t("{name} was not found. Check the name, or open the address Ovis shows under Settings → Devices and PCs → Add a connection on the PC.", { name: url.hostname }) + tailscale;
    default: return t("{host} could not be reached: {reason}", { host, reason: message }) + tailscale;
  }
}

/**
 * The PC page a link of this app's origin opens, built from the PC's scope: the page itself (`/s/<id>/`, no query) with
 * its pairing offer, an account's sign-in (signInLink) or neither; null for anything else, a file under the scope too.
 */
function pcPage(url: URL): string | null {
  const serverId = serverIdOfPath(url.pathname);
  if (serverId === null || url.pathname !== serverScopePath(serverId) || url.search !== "") return null;
  const signIn = url.hash.startsWith("#sign-in=") && (ACCOUNT_PROVIDERS as readonly string[]).includes(url.hash.slice("#sign-in=".length));
  if (url.hash !== "" && !signIn && !url.hash.startsWith("#offer=")) return null;
  return url.origin + serverScopePath(serverId) + url.hash;
}

/** One way to add a PC, as a card: its icon, what it is and where it takes the person. */
export function Way({ icon: Icon, title, sub, onClick, action, disabled = false }: { readonly icon: LucideIcon; readonly title: string; readonly sub: string; readonly onClick: () => void; readonly action: string; readonly disabled?: boolean }) {
  return (
    <button type="button" className="relay-add-way" data-action={action} disabled={disabled} onClick={onClick}>
      <span className="relay-add-way-icon"><Icon aria-hidden="true" /></span>
      <span className="relay-add-way-text"><span className="relay-add-way-title">{title}</span><span className="relay-add-way-sub">{sub}</span></span>
      <ChevronRight className="relay-add-way-chevron" aria-hidden="true" />
    </button>
  );
}

/** A PC this device paired, as this device knows it: its saved Ovis too old, or as its last check found it. */
export type SavedPc = { readonly server_id: string; readonly name?: string | undefined; readonly status?: "online" | "off" | "update" | undefined };

/** Whether the phone app around this page can scan a PC's QR code itself (a browser cannot). */
export function canScanQr(): boolean {
  return hasNativePlugin(SCANNER);
}

/**
 * Scans a PC's QR code with the phone app's scanner and hands what it read to `take`; `failed`: the scanner could not
 * run (the camera refused). The plugin's own JS fills these defaults; the page calls the bridge without it (app/web/connect.js).
 */
export function scanQr(t: Translate, take: (url: URL | null) => void, failed: (cause: unknown) => void): void {
  // the Android app asks for the camera itself first (HerdrShell camera): the scanner's own refusal is in English alone
  const camera = hasNativeMethod("HerdrShell", "camera") ? callNative<{ granted?: boolean }>("HerdrShell", "camera") : Promise.resolve({ granted: true });
  camera.then((answer) => {
    if (answer.granted !== true) { failed(new Error(t("Ovis cannot use the camera. Allow it in the phone's Settings, under Apps, Ovis, Permissions."))); return; }
    scan(t, take, failed);
  }, failed);
}

function scan(t: Translate, take: (url: URL | null) => void, failed: (cause: unknown) => void): void {
  void callNative<{ ScanResult?: string }>(SCANNER, "scanBarcode", { hint: 0, scanInstructions: t("Point at the QR code on the PC's screen"), scanButton: false, scanText: " ", cameraDirection: 1, scanOrientation: 3 }).then((result) => {
    if (result.ScanResult) take(addressOf(result.ScanResult));
  }, failed);
}

export type AddressOpen = ReturnType<typeof useAddressOpen>;

/**
 * What a scanned or typed address does, with what it ends on: `opening`, the host the phone app is opening now (Android
 * asks the address whether it is Ovis for up to 20 s; iOS opens at once), and `cancel`, which stops it, as leaving the
 * screen does by itself; `error`, why it did not open.
 */
export function useAddressOpen() {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  // the public http address the person was just warned about: opening it again goes ahead
  const warned = useRef<string | null>(null);
  // each open counts here: a later one, or a Cancel, leaves an earlier one's end unsaid
  const attempt = useRef(0);
  const pending = useRef(false);
  const stop = (): void => {
    if (!pending.current) return;
    pending.current = false;
    attempt.current += 1;
    // an app without the method (iOS, which opens at once) would never settle a call to it
    if (hasNativeMethod("HerdrShell", "cancelOpen")) void callNative("HerdrShell", "cancelOpen").catch(() => undefined);
  };
  useEffect(() => stop, []);
  const cancel = (): void => { stop(); setOpening(null); };
  const failed = (cause: unknown): void => { setError(cause instanceof Error ? cause.message : String(cause)); };
  /**
   * What a scanned or typed address does: a pairing link of this app opens at its PC's page, where the pairing asks
   * first, and so does an account PC's standing QR (its page, with the sign-in fragment or none: signInLink); a pairing
   * link of another origin is refused; a PC's own address opens (a public http one only after a warning): the phone app
   * checks it is Ovis first (HerdrShell.open, app/web/connect.js), a browser goes there; anything else says so.
   */
  const take = (url: URL | null): void => {
    if (url === null) { setError(t("That is not an http or https address.")); return; }
    const offer = url.hash.startsWith("#offer=");
    if (url.origin === window.location.origin) {
      const page = pcPage(url);
      if (page !== null) window.location.assign(page);
      else setError(t("That is not an http or https address."));
      return;
    }
    if (offer) { setError(t("This pairing link is not this app's. Scan the QR code your PC shows.")); return; }
    if (publicHttp(url) && warned.current !== url.href) {
      warned.current = url.href;
      setError(t("{host} is not on a tailnet or a home network, so plain http would send everything you type across the internet unencrypted. Use its https address, or open it again to go ahead.", { host: url.host }));
      return;
    }
    setError(null);
    if (!hasNativePlugin("HerdrShell")) { window.location.assign(url.href); return; }
    const mine = ++attempt.current;
    pending.current = true;
    setOpening(url.host);
    void callNative("HerdrShell", "open", { url: url.href, check: true }).then(() => undefined, (cause: unknown) => {
      if (mine !== attempt.current) return;
      const code = typeof (cause as { code?: unknown } | null)?.code === "string" ? (cause as { code: string }).code : undefined;
      const said = openFailureText(t, url, code, cause instanceof Error ? cause.message : String(cause));
      setError(said === "" ? null : said);
    }).finally(() => {
      if (mine !== attempt.current) return;
      pending.current = false;
      setOpening(null);
    });
  };
  return { error, setError, failed, cancel, take, opening };
}

/** What opening a PC came to: the host the phone app is opening, with Cancel, or why it did not open. */
export function OpenState({ open }: { readonly open: AddressOpen }) {
  const t = useT();
  if (open.opening !== null) {
    return (
      <p className="relay-add-opening" role="status" data-opening="">
        <span className="boot-spinner" aria-hidden="true" />
        <span className="relay-add-opening-text">{t("Opening {host}…", { host: open.opening })}</span>
        <button type="button" className="btn btn-ghost" onClick={open.cancel}>{t("Cancel")}</button>
      </p>
    );
  }
  return open.error === null ? null : <p className="account-error" role="alert">{open.error}</p>;
}

/**
 * A PC's address in one field (`label` names it) and its submit button, then what opening it ended on; `open`: the
 * opener of a screen that has other ways to open a PC beside it, which then shows what opening ended on itself.
 */
export function AddressForm({ label, placeholder, submit: submitLabel, labelShown = false, autoFocus = false, open, ssh = false }: {
  readonly label: string; readonly placeholder: string; readonly submit: string; readonly labelShown?: boolean; readonly autoFocus?: boolean; readonly open?: AddressOpen;
  /** an SSH login typed here goes to the phone app's own SSH screen (sshHandoff) */
  readonly ssh?: boolean;
}) {
  const fieldId = useId();
  const own = useAddressOpen();
  const { setError, failed, take } = open ?? own;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const typed = (event.currentTarget.elements.namedItem("address") as HTMLInputElement).value;
    const login = ssh ? sshTarget(typed) : null;
    if (login !== null) { setError(null); openSshSetup(login).catch(failed); return; }
    take(addressOf(typed));
  };
  return (
    <>
      <form className="relay-add-form" onSubmit={submit} noValidate>
        {labelShown && <label className="relay-shell-field-label" htmlFor={fieldId}>{label}</label>}
        <input id={fieldId} name="address" className="input" type="url" inputMode="url" {...(labelShown ? {} : { "aria-label": label })} placeholder={placeholder} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="url" autoFocus={autoFocus} />
        <button type="submit" className="btn btn-primary">{submitLabel}</button>
      </form>
      {open === undefined && <OpenState open={own} />}
    </>
  );
}
