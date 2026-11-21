// The connect screen: the app's first page until a PC is chosen. Opening a PC goes through the
// native HerdrShell plugin, which makes the PC's address the WebView's first page: navigating
// there from this page would cost every launch about 1.5 s (docs/native-app.md, Spike results).
import { ACCOUNT_SERVICE, ACCOUNT_SIGN_IN, APP_ORIGIN, barsForScreen, directTarget, followScheme, listedProviders, localize, openFailure, parseAddress, publicHttp, relayLink, shell, sshDetails, t, tabPcs } from "./shell.js";

localize();
followScheme();

const form = document.getElementById("connect");
const input = document.getElementById("address");
const error = document.getElementById("error");
const spinner = document.getElementById("spinner");
const statusText = document.getElementById("status-text");
const cancel = document.getElementById("cancel");
const android = window.Capacitor?.getPlatform?.() === "android";
let attempt = 0;
let pending = false;

/**
 * Shows what opens, or nothing. The status text is a live region that stays in the page, empty when
 * nothing opens: one that appeared together with its text would not be announced.
 */
function showStatus(text) {
  pending = text !== "";
  statusText.textContent = text;
  spinner.hidden = !pending;
  cancel.hidden = !pending;
}

function stopPending() {
  if (!pending) return;
  attempt++;
  showStatus("");
  barsForScreen();
  if (android) void shell("cancelOpen");
}
/** PCs that loaded before (an origin, or a relay PC's scope), and the public http address the user was just warned about. */
let savedOrigins = [];
let warned = "";
/** The PCs added over SSH (Android's OvisSsh plugin), by their loopback origin on this phone. */
let sshPcs = {};

/** Calls Android's OvisSsh plugin (app/android/.../OvisSshPlugin.java). */
function ssh(method, options = {}) {
  return window.Capacitor.nativePromise("OvisSsh", method, options);
}

const appHost = new URL(APP_ORIGIN).host;
const relayErrors = {
  "foreign-offer": () => t(
    `This pairing link is not on the Ovis app's address (${appHost}), so the app does not open it. Scan the QR code your PC shows.`,
    `이 페어링 링크는 Ovis 앱 주소(${appHost})가 아니어서 열지 않습니다. PC에 표시된 QR 코드를 스캔하세요.`,
  ),
  "bad-offer": () => t(
    "This pairing link is damaged or names another PC. Show the QR code on your PC again and scan it.",
    "이 페어링 링크가 손상되었거나 다른 PC를 가리킵니다. PC에서 QR 코드를 다시 띄워 스캔하세요.",
  ),
  "not-a-pc": () => t(
    `That is a page of the Ovis app (${appHost}), not a PC. Scan the QR code your PC shows.`,
    `Ovis 앱(${appHost})의 페이지이지 PC가 아닙니다. PC에 표시된 QR 코드를 스캔하세요.`,
  ),
};

async function open(text) {
  stopPending();
  // the bundled demo (build-web.ts), for a store review without a PC: the address "demo" opens it, with no button for it
  if (String(text).trim().toLowerCase() === "demo") { location.href = "demo/index.html"; return; }
  // an SSH PC whose host key was forgotten on purpose opens only through the setup screen, which shows the key to confirm
  const url = parseAddress(text);
  // looked up by origin, as each is saved, so the address typed with a path or a trailing slash finds it too
  const sshPc = url === null ? undefined : sshPcs[url.origin];
  if (sshPc && !sshDetails(sshPc).confirmed) {
    error.textContent = "";
    try { await ssh("setUp", { origin: sshPc.origin }); }
    catch (err) { error.textContent = String(err?.message ?? err); }
    return;
  }
  if (url === null) { error.textContent = t("That is not an http or https address.", "http 또는 https 주소가 아닙니다."); focusField(); return; }
  // the hosted app itself, saved once it loaded (a sign-in opens it): picked from this list, it opens on its front page
  // (#pcs, which the hosted app takes as the app's own way there: Add a PC, or its sign-in), not straight into the PC it
  // opened last as a launch does (src/lib/relay/shell.tsx, launchOrder): a new web view starts a new session, so a bare
  // address would count as a launch and loop back to the PC just left
  if (url.origin === new URL(APP_ORIGIN).origin && url.pathname === "/" && url.hash === "") {
    error.textContent = "";
    try { await shell("open", { url: `${APP_ORIGIN}/#pcs`, name: "Ovis" }); }
    catch (err) { error.textContent = String(err?.message ?? err); }
    return;
  }
  // a PC paired over the Ovis relay opens at its scope on the app's origin, saved under that scope
  const relay = relayLink(url);
  if (relay?.error) { error.textContent = relayErrors[relay.error](); focusField(); return; }
  if (relay) {
    error.textContent = "";
    // #picked: the person chose this PC now, so the app does not move on to another one if it is off (src/lib/relay/shell.tsx);
    // a link that carries its own fragment (a pairing offer) is never a reopen, so it needs none
    const picked = new URL(relay.url);
    if (picked.hash === "") picked.hash = "picked";
    try { await shell("open", { url: picked.href, scope: relay.scope, ...(relay.name ? { name: relay.name } : {}) }); }
    catch (err) { error.textContent = String(err?.message ?? err); }
    return;
  }
  if (publicHttp(url) && !savedOrigins.some((saved) => new URL(saved).origin === url.origin) && warned !== url.href) {
    warned = url.href;
    error.textContent = t(
      `${url.host} is not on a tailnet or a home network, so plain http would send the pairing code and everything you type across the internet unencrypted. Use its https address, or open it again to go ahead.`,
      `${url.host}은(는) tailnet이나 집 네트워크의 주소가 아니어서, 일반 http로는 페어링 코드와 입력하는 모든 내용이 암호화되지 않은 채 인터넷으로 오갑니다. https 주소를 쓰거나, 그래도 열려면 한 번 더 여세요.`,
    );
    return;
  }
  // the Android app first asks the address whether it is Ovis (PCStore.check), for up to 20 s:
  // until it answers the screen says what it opens, with Cancel. The iOS app opens it at once.
  error.textContent = "";
  const mine = ++attempt;
  showStatus(t(`Opening ${url.host}…`, `${url.host} 여는 중…`));
  try { await shell("open", { url: url.href, check: true }); }
  catch (err) { if (mine === attempt) error.textContent = openFailure(url, err?.code, String(err?.message ?? err)); }
  finally { if (mine === attempt) showStatus(""); }
}

const tabs = [...document.querySelectorAll('[role="tab"]')];
const tailnetInput = document.getElementById("tailnet-address");
// a build without the account (OVIS_APP_ACCOUNT=0, build-web.ts) has no relay tab and opens on Tailscale
if (!ACCOUNT_SIGN_IN) document.getElementById("tab-relay").hidden = true;
let tab = ACCOUNT_SIGN_IN ? "relay" : "tailscale";

/** The field of the tab that is up, for an open that did not go: none on the relay's tab. */
function focusField() {
  if (tab === "direct") input.focus();
  else if (tab === "tailscale" && !tailnetInput.closest("[hidden]")) tailnetInput.focus();
}

/**
 * One tab at a time, picked rather than stepped to: no entry of the page's history, so the phone's Back leaves the app
 * from any tab (MainActivity.syncBack gives Back to the page only when it has history), as it does on the desktop's
 * Add a connection. What an open said goes with the tab it was said on.
 */
function pick(name, focus = false) {
  if (name !== tab) {
    stopPending();
    error.textContent = "";
  }
  tab = name;
  for (const each of tabs) {
    const on = each.dataset.tab === name;
    each.setAttribute("aria-selected", String(on));
    each.tabIndex = on ? 0 : -1;
    document.getElementById(each.getAttribute("aria-controls")).hidden = !on;
  }
  if (focus) tabs.find((each) => each.dataset.tab === name)?.focus();
  if (name === "tailscale") void checkTailscale();
}

for (const each of tabs) each.addEventListener("click", () => pick(each.dataset.tab));
// a tab list's own keys: the arrows move between the tabs that are drawn, Home and End to the ends
document.querySelector('[role="tablist"]').addEventListener("keydown", (event) => {
  const shown = tabs.filter((each) => !each.hidden);
  const at = shown.findIndex((each) => each.dataset.tab === tab);
  const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: shown.length - 1 }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  pick(shown[(to + shown.length) % shown.length].dataset.tab, true);
});
pick(tab);

// a machine reached over SSH from this phone: Android's OvisSsh plugin asks the rest on a screen of its own. An app
// without it (iOS, or an Android build before it) has no SSH to offer, so Direct's field takes addresses alone
// the plugins the app announces to the page before its first script runs (src/lib/nativeApp.ts, hasNativePlugin)
const sshOffered = (window.Capacitor?.PluginHeaders ?? []).some((header) => header.name === "OvisSsh");
if (!sshOffered) {
  input.placeholder = "192.168.0.10:7317";
  document.getElementById("address-label").textContent = t("Address", "주소");
  document.getElementById("address-hint").textContent = t("A same Wi-Fi address or an https address", "같은 Wi-Fi 주소 또는 https 주소");
}

/** Direct's one field: SSH's user@host goes to the SSH setup screen with it filled in, anything else opens as an address. */
async function connectDirect(text) {
  const target = directTarget(text);
  if (!target.ssh) { await open(target.address); return; }
  if (!sshOffered) {
    error.textContent = t("SSH works in the Android app. Type the PC's Ovis address instead.", "SSH는 안드로이드 앱에서 돼요. PC의 Ovis 주소를 넣으세요.");
    input.focus();
    return;
  }
  // an open still being checked must not take over while the setup screen is up
  stopPending();
  error.textContent = "";
  try { await ssh("add", target.ssh); }
  catch (err) { error.textContent = String(err?.message ?? err); }
}

cancel.addEventListener("click", () => {
  stopPending();
  focusField();
});

form.addEventListener("submit", (event) => { event.preventDefault(); void connectDirect(input.value); });
document.getElementById("tailnet-connect").addEventListener("submit", (event) => { event.preventDefault(); void open(tailnetInput.value); });

/**
 * Whether Tailscale is on on this phone, as Android tells (HerdrShell tailscale): off, the tab says so and offers its
 * app alone, since no Tailscale address opens meanwhile; it asks again when the app comes back (from Tailscale). An app
 * that cannot tell (iOS, an older Android build) draws the tab as on.
 */
async function checkTailscale() {
  if (!android) return;
  let on = true;
  try { on = (await shell("tailscale")).on !== false; }
  catch { /* an Android build without the check: as on */ }
  document.getElementById("tailscale-off").hidden = on;
  document.getElementById("tailscale-on").hidden = !on;
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && tab === "tailscale") void checkTailscale(); });
document.getElementById("open-tailscale").addEventListener("click", async () => {
  error.textContent = "";
  try { await shell("openTailscale"); }
  catch (err) { error.textContent = String(err?.message ?? err); }
});

const account = document.getElementById("account");
/** Draws a button for each sign-in named, in the build's order. */
function showProviders(providers) {
  for (const button of account.querySelectorAll("[data-provider]")) button.hidden = !providers.includes(button.dataset.provider);
}

if (ACCOUNT_SIGN_IN) {
  // the service names its sign-ins (GET /v1/providers), as the hosted app reads them; until it answers, GitHub alone
  // (the markup's), the hosted app's own fallback, so no button opens a sign-in the hosted app would not start
  fetch(new URL("/v1/providers", ACCOUNT_SERVICE)).then((response) => response.ok ? response.json() : null).then((body) => {
    const listed = listedProviders(body);
    if (listed !== null) showProviders(listed);
  }, () => undefined);
  // the sign-in itself runs on the hosted app, which this opens on that provider's sign-in (#sign-in=, boot.ts). One
  // press at a time, and none after one that went (Android answers before the page is replaced): a second open would
  // race the first for the page the app keeps
  const buttons = [...account.querySelectorAll("[data-provider]")];
  for (const button of buttons) button.addEventListener("click", async () => {
    error.textContent = "";
    for (const each of buttons) each.disabled = true;
    try { await shell("open", { url: `${APP_ORIGIN}/#sign-in=${button.dataset.provider}`, name: "Ovis" }); }
    catch (err) {
      error.textContent = String(err?.message ?? err);
      for (const each of buttons) each.disabled = false;
    }
  });
}

for (const scan of document.querySelectorAll("[data-scan]")) scan.addEventListener("click", async () => {
  error.textContent = "";
  try {
    // the plugin's own JS fills these defaults; this page calls the bridge without it
    const result = await window.Capacitor.nativePromise("CapacitorBarcodeScanner", "scanBarcode", { hint: 0, scanInstructions: t("Point at the QR code under Settings → Phone & devices on your PC", "PC의 설정 → 폰 및 기기에 있는 QR 코드를 비추세요"), scanButton: false, scanText: " ", cameraDirection: 1, scanOrientation: 3 });
    if (result?.ScanResult) await open(result.ScanResult);
  } catch (err) {
    error.textContent = String(err?.message ?? err);
  }
});

const WAY_TAGS = { tailscale: () => "Tailscale", direct: () => t("Direct", "직접"), ssh: () => "SSH" };

/**
 * A tab's own saved PCs (tabPcs: the Tailscale tab's at a tailnet address, Direct's at any other, none on the relay's):
 * each a compact row of its name, the way it connects and, for the PC this screen was opened from, Connected; with
 * Connect, and Forget (an SSH PC's Manage, as its keys live on this phone).
 */
function renderPcs(tab, list, section, state) {
  const pcs = tabPcs(savedOrigins, tab, state.names ?? {}, sshPcs);
  list.replaceChildren(...pcs.flatMap(({ origin, label, way }) => {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.className = "way-text";
    const title = document.createElement("span");
    title.className = "way-title pc-name";
    title.textContent = label;
    // the second line: the way it connects, Connected for the PC this screen was opened from, then its address
    const sub = document.createElement("span");
    sub.className = "sub pc-sub";
    const tag = document.createElement("span");
    tag.className = "pc-tag";
    tag.textContent = WAY_TAGS[way]();
    sub.append(tag);
    if (state.choosing === true && origin === state.current) {
      const on = document.createElement("span");
      on.className = "pc-on";
      on.textContent = t("Connected", "연결됨");
      sub.append(on);
    }
    const address = document.createElement("span");
    address.className = "pc-address";
    address.textContent = way === "ssh" ? sshDetails(sshPcs[origin]).address : new URL(origin).host;
    sub.append(address);
    text.append(title, sub);
    const connect = button(t("Connect", "연결"), () => void open(origin), "primary");
    connect.setAttribute("aria-label", t(`Connect to ${label}`, `${label}에 연결`));
    if (way !== "ssh") {
      const forget = button(t("Forget", "지우기"), async () => { await shell("forget", { url: origin }); await load(); }, "forget");
      forget.setAttribute("aria-label", t(`Forget ${label}`, `${label} 지우기`));
      item.append(text, connect, forget);
      return [item];
    }
    const manage = button(t("Manage", "관리"), () => {
      const shown = item.nextElementSibling?.classList.contains("manage-row");
      if (shown) { item.nextElementSibling.remove(); manage.setAttribute("aria-expanded", "false"); return; }
      const row = document.createElement("li");
      row.className = "manage-row";
      row.append(managePanel(origin, label));
      item.after(row);
      manage.setAttribute("aria-expanded", "true");
    }, "forget");
    manage.setAttribute("aria-expanded", "false");
    manage.setAttribute("aria-label", t(`Manage ${label}`, `${label} 관리`));
    item.append(text, connect, manage);
    return [item];
  }));
  section.hidden = pcs.length === 0;
  return pcs.length;
}

function button(text, onClick, className = "") {
  const element = document.createElement("button");
  element.type = "button";
  if (className) element.className = className;
  element.textContent = text;
  element.addEventListener("click", onClick);
  return element;
}

function paragraph(text, className = "") {
  const element = document.createElement("p");
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

/**
 * Manage under an SSH PC in the list: what it is, and what can be done to it here. Each action says
 * what happened in the panel's own line, so nothing happens out of sight.
 */
function managePanel(origin, label) {
  const pc = sshPcs[origin];
  const details = sshDetails(pc);
  const panel = document.createElement("div");
  panel.className = "manage";
  panel.id = `manage-${origin.replace(/[^a-z0-9]/gi, "-")}`;
  const said = paragraph("", "said");
  said.setAttribute("role", "status");
  const say = (text) => { said.textContent = text; };
  const fail = (err) => { said.textContent = String(err?.message ?? err); };
  const actions = document.createElement("div");
  actions.className = "actions";
  const extra = document.createElement("div");

  const rename = button(t("Rename", "이름 바꾸기"), () => {
    const input = document.createElement("input");
    input.value = label;
    input.maxLength = 64;
    input.setAttribute("aria-label", t("Name in the list", "목록에 보일 이름"));
    const save = button(t("Save", "저장"), async () => {
      try { await ssh("rename", { origin, name: input.value }); await load(); }
      catch (err) { fail(err); }
    }, "primary");
    extra.replaceChildren(input, save);
    input.focus();
  });
  const phoneKey = button(t("Show this phone's key", "이 휴대폰의 키 보기"), async () => {
    try {
      const { line } = await ssh("phoneKey");
      const code = document.createElement("code");
      code.className = "key";
      code.textContent = line;
      const copy = button(t("Copy", "복사"), async () => { await ssh("copy", { text: line }); say(t("Copied.", "복사했습니다.")); });
      const share = button(t("Share", "공유"), async () => { await ssh("share", { text: line }); });
      extra.replaceChildren(paragraph(t("This phone signs in with this key. It goes in ~/.ssh/authorized_keys on the PC:", "이 휴대폰은 이 키로 로그인합니다. PC의 ~/.ssh/authorized_keys에 들어갑니다:")), code, copy, share);
    } catch (err) { fail(err); }
  });
  const setUp = button(t("Set up again", "다시 설정"), async () => {
    stopPending();
    try { await ssh("setUp", { origin }); }
    catch (err) { fail(err); }
  });
  const forgetKey = button(t("Forget host key", "호스트 키 지우기"), () => {
    const yes = button(t("Forget it", "지우기"), async () => {
      try { await ssh("forgetHostKey", { origin }); await load(); }
      catch (err) { fail(err); }
    }, "primary");
    extra.replaceChildren(paragraph(t(
      "Only when you know why the PC's SSH key changed (the machine was reinstalled, its keys replaced). Opening it then shows the key it has now, to check on the PC and confirm.",
      "PC의 SSH 키가 왜 바뀌었는지 알 때만 지우세요(기기를 다시 설치했거나 키를 바꾼 경우). 그 뒤 열면 지금의 키를 보여 주니, PC에서 확인하고 신뢰하세요.",
    )), yes);
  });
  const remove = button(t("Remove", "삭제"), () => {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `${panel.id}-clean`;
    box.checked = pc.auth === "phone-key";
    box.disabled = pc.auth !== "phone-key" || !details.confirmed;
    const boxLabel = document.createElement("label");
    boxLabel.className = "check";
    boxLabel.htmlFor = box.id;
    boxLabel.textContent = t("Also take this phone's key out of the PC's authorized_keys (the PC has to be reachable)", "PC의 authorized_keys에서도 이 휴대폰의 키를 빼기(PC에 닿아야 함)");
    boxLabel.prepend(box);
    const yes = button(t("Remove", "삭제"), async () => {
      try {
        const { remote, reason } = await ssh("remove", { origin, cleanRemote: box.checked });
        await load();
        if (remote === "failed") error.textContent = t(`${label} was removed from this phone, but its key could not be taken out of the PC (${reason}). Remove the line whose comment starts with ovis-phone: from ~/.ssh/authorized_keys there yourself.`, `${label}을(를) 이 휴대폰에서 지웠지만 PC에서 키를 빼지 못했습니다(${reason}). 그쪽 ~/.ssh/authorized_keys에서 주석이 ovis-phone:으로 시작하는 줄을 직접 지우세요.`);
      } catch (err) { fail(err); }
    }, "primary");
    extra.replaceChildren(paragraph(t(`Remove ${label} from this phone? Its host key and the key saved for it go too.`, `이 휴대폰에서 ${label}을(를) 지울까요? 호스트 키와 이 PC용으로 저장한 키도 함께 지워집니다.`)), boxLabel, yes);
  });
  actions.append(rename, phoneKey, setUp, ...(details.confirmed ? [forgetKey] : []), remove);
  panel.append(paragraph(details.address), paragraph(details.how), paragraph(details.hostKey, "key"), actions, extra, said);
  return panel;
}

async function load() {
  const state = await shell("getState");
  savedOrigins = state.saved ?? [];
  sshPcs = {};
  if (android) {
    try { for (const pc of (await ssh("list")).pcs ?? []) sshPcs[pc.origin] = pc; }
    catch { /* an app without the plugin lists its PCs as before */ }
  }
  const tailnet = renderPcs("tailscale", document.getElementById("tailnet"), document.getElementById("tailnet-section"), state);
  document.getElementById("tailnet-none").hidden = tailnet > 0;
  renderPcs("direct", document.getElementById("direct-pcs"), document.getElementById("direct-section"), state);
  // an SSH PC whose address on this phone another app took first is not opened (OvisSshPlugin.listen)
  if (state.kind === "ssh-port") {
    error.textContent = t(
      `Another app on this phone took the address the SSH PC opens on (${state.failure}), so the app did not open it: that app would have answered in its place. Close or uninstall the app you do not know, or restart the phone, then open the PC again.`,
      `이 휴대폰의 다른 앱이 SSH PC가 열리는 주소(${state.failure})를 먼저 차지해서 열지 않았습니다. 그 앱이 대신 응답할 수 있기 때문입니다. 모르는 앱을 닫거나 지우거나 휴대폰을 다시 시작한 뒤 PC를 다시 여세요.`,
    );
  }
}

void load();

// a PC's link on the app's origin tapped outside the app (a message, the camera reading the PC's QR
// code), which Android hands to the app (MainActivity's app link): opened as a scanned QR code is
async function openAppLink() {
  if (window.Capacitor?.getPlatform?.() !== "android") return;
  const { url } = await shell("takeLink");
  if (!url) return;
  pick("direct");
  input.value = url;
  await open(url);
}

void openAppLink();

// SSH asked for on a PC's page (the hosted app's Direct tab, HerdrShell openSshSetup): only the app's own pages add an
// SSH PC, so it comes here, on Direct with the login filled in, and goes to the SSH setup screen as typed here would
async function openSshSetupAsked() {
  let asked;
  try { asked = await shell("takeSshSetup"); }
  catch { return; }
  if (!asked?.asked) return;
  pick("direct");
  input.value = asked.target;
  if (directTarget(asked.target).ssh) await connectDirect(asked.target);
  else input.focus();
}

void openSshSetupAsked();
