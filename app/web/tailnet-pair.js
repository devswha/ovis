// The PC, both scanners and the standalone Pages fallback use this same wire format.
const PAGE = "https://app.ovis.sh/t/";
const FRAGMENT = /^#([a-z0-9.-]{1,253})(?::([1-9][0-9]{0,4}))?\/([0-9]{6})$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function tailnetPairTarget(href) {
  if (!href.startsWith(PAGE)) return null;
  const parts = FRAGMENT.exec(href.slice(PAGE.length));
  if (!parts) return null;
  const [, host, port, code] = parts;
  if (!host.endsWith(".ts.net") || !host.split(".").every(label => LABEL.test(label)) || Number(port) > 65535) return null;
  // Construct a destination; never navigate to a URL supplied by the fragment.
  return new URL(`https://${host}${port ? `:${port}` : ""}/?pair=${code}`);
}

export function unwrapPairAddress(url) {
  return url.origin === "https://app.ovis.sh" && url.pathname === "/t/" ? tailnetPairTarget(url.href) : url;
}

export function pairQrUrl(address, code) {
  const base = address.replace(/\/$/, "");
  const direct = `${base}/?pair=${code}`;
  if (!base.startsWith("https://")) return direct;
  const wrapped = `${PAGE}#${base.slice("https://".length).toLowerCase()}/${code}`;
  // LAN addresses and custom reverse proxies stay direct, never a hosted open redirect.
  return tailnetPairTarget(wrapped) ? wrapped : direct;
}
