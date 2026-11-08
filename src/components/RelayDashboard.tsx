import "./RelayDashboard.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, LayoutGrid, Monitor, Plus, Settings, Smartphone, Waypoints, X, type LucideIcon } from "lucide-react";
import { newPcs, type MyPc } from "../lib/account/myPcs.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { LANGUAGE_NAMES, LANGUAGE_SETTINGS, useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import { dashboardModel, relayHost, type DashboardFilter, type DashboardPc } from "../lib/relay/dashboard.ts";
import { formatDashboardHash, isDashboardHash, parseDashboardHash, type DashboardRoute, type DashboardView } from "../lib/relay/dashboardRoute.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { uiFontSize, useSettings } from "../lib/settings.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { UI_FONT_MAX, UI_FONT_MIN } from "../lib/typography.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { accountPcStateText, CheckPcsButton, pcStateWord, PcStatusLine, PROVIDER_NAMES, ProviderMark } from "./AccountPcs.tsx";
import { RelayMap } from "./RelayMap.tsx";
import { Segmented, SettingsBare, SettingsGroup, SettingsRow, SettingsSelect, Stepper } from "./SettingsControls.tsx";
import { StatusDot, type StatusDotState } from "./StatusDot.tsx";

const PHONE_QUERY = "(max-width: 768px)";
const DOT_STATE: Record<MyPc["state"], StatusDotState> = { paired: "ready", "needs-approval": "needs-you", "needs-update": "needs-you", offline: "offline" };

export interface RelayDashboardProps {
  pcs: readonly DashboardPc[] | null;
  account: { provider: AccountProvider } | null;
  defaultRelay: string;
  meLabel: string;
  error?: string | null;
  pcStatus?: ReadonlyMap<string, PcStatus>;
  onCheckPcs?: () => void;
  onAddPc: () => void;
  onOpenSheet: (pc: MyPc, mode: "new" | "join") => void;
  onSignIn?: () => void;
  onSignOut?: () => void;
  onLeave?: () => void;
}

type Place = { view: DashboardView; href: string; Icon: LucideIcon; label: string; current: boolean; count?: number };

function PlaceLink({ place, as, onNavigate }: { place: Place; as: "relay-dash-nav-item" | "relay-dash-tab"; onNavigate: (href: string) => void }) {
  return (
    <a className={as} href={place.href} aria-current={place.current ? "page" : undefined} onClick={(e) => { e.preventDefault(); onNavigate(place.href); }}>
      <place.Icon aria-hidden="true" /><span>{place.label}</span>
      {as === "relay-dash-nav-item" && place.count !== undefined && <span className="relay-dash-nav-count">{place.count}</span>}
    </a>
  );
}

function SidebarFoot({ account, onSignIn, onSignOut }: Pick<RelayDashboardProps, "account" | "onSignIn" | "onSignOut">) {
  const t = useT();
  if (account === null) {
    return <div className="relay-dash-foot"><p className="relay-dash-who"><Smartphone aria-hidden="true" /><span>{t("Without an account")}</span></p>{onSignIn && <button type="button" className="btn" onClick={onSignIn}>{t("Sign in")}</button>}</div>;
  }
  return <div className="relay-dash-foot"><p className="relay-dash-who"><ProviderMark provider={account.provider} /><span>{t("Signed in with {provider}", { provider: PROVIDER_NAMES[account.provider] })}</span></p>{onSignOut && <button type="button" className="account-link" onClick={onSignOut}>{t("Sign out")}</button>}</div>;
}

function DevicesSection({ meLabel, account, onSignIn, onSignOut, onLeave }: Pick<RelayDashboardProps, "meLabel" | "account" | "onSignIn" | "onSignOut" | "onLeave">) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="relay-dash-view-stack">
      <section className="relay-dash-panel" aria-labelledby="relay-dash-this-device-title">
        <h2 className="relay-dash-h" id="relay-dash-this-device-title">{t("This device")}</h2>
        <div className="relay-dash-device-row"><Smartphone className="relay-dash-device-icon" aria-hidden="true" /><span className="relay-dash-device-name">{meLabel}</span><span className="pill">{t("This device")}</span></div>
      </section>
      <section className="relay-dash-panel" id="relay-dash-device" aria-labelledby="relay-dash-account-title">
        <h2 className="relay-dash-h" id="relay-dash-account-title">{t("Account")}</h2>
        {account === null ? (
          <div className="relay-dash-account-box"><p className="relay-dash-who"><Smartphone aria-hidden="true" /><span>{t("Without an account")}</span></p>{onSignIn && <div className="relay-dash-account-actions"><button type="button" className="btn" onClick={onSignIn}>{t("Sign in")}</button></div>}</div>
        ) : (
          <div className="relay-dash-account-box">
            <p className="relay-dash-who"><ProviderMark provider={account.provider} /><span>{t("Signed in with {provider}", { provider: PROVIDER_NAMES[account.provider] })}</span></p>
            {confirming && onLeave && <p className="account-fineprint" role="status">{t("Every PC of the account removes this device. QR pairings outside the account stay.")}</p>}
            <div className="relay-dash-account-actions">
              {onSignOut && <button type="button" className="btn" onClick={onSignOut}>{t("Sign out")}</button>}
              {onLeave && <button type="button" className={confirming ? "btn btn-danger" : "btn"} data-action="remove-device" data-confirm={confirming ? "remove-device" : undefined} onClick={() => { if (confirming) onLeave(); else setConfirming(true); }}>{confirming ? t("Remove this device?") : t("Remove this device from your account")}</button>}
              {confirming && <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>{t("Cancel")}</button>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function SettingsSection() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <div className="relay-dash-view-stack">
      <SettingsBare.Provider value={true}>
        <SettingsGroup>
          <SettingsRow label={t("Theme")} wide reset={["theme"]}><Segmented label={t("Theme")} value={settings.theme} onChange={(theme) => update({ theme })} options={[{ value: "dark", label: t("Dark") }, { value: "light", label: t("Light") }, { value: "system", label: t("System") }]} /></SettingsRow>
          <SettingsRow label={t("Density")} wide reset={["density"]}><Segmented label={t("Density")} value={settings.density} onChange={(density) => update({ density })} options={[{ value: "comfortable", label: t("Comfortable") }, { value: "compact", label: t("Compact") }]} /></SettingsRow>
          <SettingsRow label={t("Interface font size")} reset={["uiFontSize"]}><Stepper label={t("Interface font size")} value={uiFontSize(settings)} text={`${uiFontSize(settings)}px`} min={UI_FONT_MIN} max={UI_FONT_MAX} decreaseLabel={t("Decrease interface font size")} increaseLabel={t("Increase interface font size")} onChange={(size) => update({ uiFontSize: size })} /></SettingsRow>
          <SettingsRow label={t("Language")} htmlFor="relay-settings-language" reset={["language"]}>
            <SettingsSelect id="relay-settings-language" value={settings.language} onChange={(event) => update({ language: event.target.value as typeof settings.language })}>{LANGUAGE_SETTINGS.map((language) => <option key={language} value={language}>{language === "system" ? t("System") : LANGUAGE_NAMES[language]}</option>)}</SettingsSelect>
          </SettingsRow>
        </SettingsGroup>
      </SettingsBare.Provider>
    </div>
  );
}

export function RelayDashboard({ pcs, account, defaultRelay, meLabel, error = null, pcStatus, onCheckPcs, onAddPc, onOpenSheet, onSignIn, onSignOut, onLeave }: RelayDashboardProps) {
  const t = useT(), phone = useMediaQuery(PHONE_QUERY);
  const [route, setRoute] = useState<DashboardRoute>(() => typeof window === "undefined" ? { view: "overview", filter: "all", relay: null, pc: null } : parseDashboardHash(window.location.hash));
  const [localFilter, setLocalFilter] = useState<DashboardFilter>("all");
  const titleRef = useRef<HTMLHeadingElement>(null), prevViewRef = useRef<DashboardView>(route.view);

  useEffect(() => {
    const sync = () => { if (!window.location.hash || window.location.hash === "#" || isDashboardHash(window.location.hash)) setRoute(parseDashboardHash(window.location.hash)); };
    window.addEventListener("hashchange", sync); window.addEventListener("popstate", sync);
    return () => { window.removeEventListener("hashchange", sync); window.removeEventListener("popstate", sync); };
  }, []);

  useEffect(() => { if (prevViewRef.current !== route.view) { prevViewRef.current = route.view; titleRef.current?.focus(); } }, [route.view]);

  const navigateTo = (nextHash: string) => {
    setRoute(parseDashboardHash(nextHash));
    if (typeof window !== "undefined" && window.location.hash !== nextHash) window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
  };
  const activeFilter: DashboardFilter = route.view === "pcs" ? route.filter : localFilter;
  const setFilter = (next: DashboardFilter) => route.view === "pcs" ? navigateTo(formatDashboardHash({ view: "pcs", filter: next, relay: route.relay, pc: route.pc })) : setLocalFilter(next);

  const model = pcs === null ? null : dashboardModel(pcs, { label: meLabel, ...(pcStatus ? { status: pcStatus } : {}) }, defaultRelay);
  const fresh = new Set(pcs === null ? [] : newPcs(pcs, Date.now()).map((pc) => pc.server_id));
  const byId = new Map((pcs ?? []).map((pc) => [pc.server_id, pc])), waiting = pcs?.find((pc) => pc.state === "needs-approval");
  const filterSet = model ? new Set(model.filters[activeFilter]) : null;
  const shown = (pcs ?? []).filter((pc) => (filterSet ? filterSet.has(pc.server_id) : true) && (route.view !== "pcs" || route.relay === null || (pc.relay ?? defaultRelay) === route.relay));
  const selectedPc = route.view === "pcs" && route.pc !== null ? byId.get(route.pc) ?? null : null;
  const scope = (pc: MyPc): string => serverScopePath(pc.server_id);
  const openDetails = (pc: MyPc) => navigateTo(formatDashboardHash({ view: "pcs", filter: activeFilter, relay: route.relay, pc: pc.server_id }));

  const action = (pc: DashboardPc): ReactNode => {
    switch (pc.state) {
      case "paired": return <a className="btn btn-primary" data-pc-action="open" href={scope(pc)}>{t("Open")}</a>;
      case "needs-approval": return pc.join === undefined ? null : fresh.has(pc.server_id) ? <button type="button" className="btn" data-pc-action="add" onClick={() => onOpenSheet(pc, "new")}>{t("Add")}</button> : <button type="button" className="btn" data-pc-action="join" onClick={() => onOpenSheet(pc, "join")}>{t("Join")}</button>;
      case "needs-update": return pc.paired ? <a className="btn" data-pc-action="update" href={scope(pc)}>{t("Update")}</a> : null;
      case "offline": return pc.paired ? <a className="btn" data-pc-action="details" href={scope(pc)} onClick={(e) => { e.preventDefault(); openDetails(pc); }}>{t("Details")}</a> : pc.join === undefined ? null : <button type="button" className="btn" data-pc-action="join" onClick={() => onOpenSheet(pc, "join")}>{t("Join")}</button>;
    }
  };
  const under = (pc: DashboardPc): string => pc.listed && !(pc.paired && !pc.linked) ? (fresh.has(pc.server_id) ? t("new in your account") : t("in your account")) : account ? t("paired by QR · not in the account yet") : t("paired with this device");

  const viewTitles: Record<DashboardView, string> = { overview: t("Overview"), pcs: t("PCs"), devices: t("Devices"), relay: t("Relay"), settings: t("Settings") };
  const places: Place[] = [
    { view: "overview", href: "#overview", Icon: LayoutGrid, label: viewTitles.overview, current: route.view === "overview", ...(model && model.counts.needsYou > 0 ? { count: model.counts.needsYou } : {}) },
    { view: "pcs", href: "#pcs", Icon: Monitor, label: viewTitles.pcs, current: route.view === "pcs", ...(pcs !== null && pcs.length > 0 ? { count: pcs.length } : {}) },
    { view: "devices", href: "#devices", Icon: Smartphone, label: viewTitles.devices, current: route.view === "devices" },
    { view: "relay", href: "#relay", Icon: Waypoints, label: viewTitles.relay, current: route.view === "relay" },
    { view: "settings", href: "#settings", Icon: Settings, label: viewTitles.settings, current: route.view === "settings" },
  ];

  const renderTable = (list: readonly DashboardPc[]) => (
    <section className="relay-dash-pcs" id="relay-dash-pcs" aria-labelledby="relay-dash-pcs-title">
      <div className="relay-dash-pcs-head">
        <h2 className="relay-dash-h" id="relay-dash-pcs-title">{t("PCs")}</h2>
        {onCheckPcs && list.some((pc) => pc.paired) && <CheckPcsButton status={pcStatus ?? new Map()} onCheck={onCheckPcs} />}
        <div className="segmented" role="group" aria-label={t("Filter")}>
          <button type="button" aria-pressed={activeFilter === "all"} onClick={() => setFilter("all")}>{t("All")}</button>
          <button type="button" aria-pressed={activeFilter === "ready"} onClick={() => setFilter("ready")}>{pcStateWord("paired", t)}</button>
          <button type="button" aria-pressed={activeFilter === "needs"} onClick={() => setFilter("needs")}>{t("Needs you")}</button>
          {route.view === "pcs" && <button type="button" aria-pressed={activeFilter === "offline"} onClick={() => setFilter("offline")}>{pcStateWord("offline", t)}</button>}
        </div>
      </div>
      <div className={selectedPc ? "relay-dash-pcs-split is-selected" : "relay-dash-pcs-split"}>
        <div className="relay-dash-pcs-list">
          <table className="relay-dash-table" data-pc-list="">
            <colgroup><col className="relay-dash-col-name" /><col className="relay-dash-col-state" /><col className="relay-dash-col-relay" /><col className="relay-dash-col-seen" /><col className="relay-dash-col-act" /></colgroup>
            <thead><tr><th scope="col">{t("Name")}</th><th scope="col">{t("State")}</th><th scope="col">{t("Relay")}</th><th scope="col">{t("Last seen")}</th><th scope="col"><span className="visually-hidden">{t("Action")}</span></th></tr></thead>
            <tbody>
              {shown.map((pc) => {
                const offline = pc.state === "offline", status = pc.paired ? pcStatus?.get(pc.server_id) : undefined;
                return (
                  <tr key={pc.server_id} data-pc-state={pc.state} aria-selected={selectedPc?.server_id === pc.server_id || undefined}>
                    <td><div className="relay-dash-name"><span className="relay-dash-name-icon" aria-hidden="true"><Monitor /></span><span className="relay-dash-name-text"><b title={pc.name}>{pc.name}</b><small>{under(pc)}</small></span></div></td>
                    <td className="relay-dash-state-cell">
                      {!offline && status ? <PcStatusLine status={status} lastSeenAt={pc.last_seen_at} /> : <span className="relay-dash-state"><StatusDot state={DOT_STATE[pc.state]} />{offline || (pc.paired && !pc.linked && account) ? accountPcStateText(pc, t) : pcStateWord(pc.state, t)}</span>}
                      {offline && status?.kind === "answered" && <small className="relay-dash-state-note">{t("Answered this device's latest check")}</small>}
                    </td>
                    <td className="relay-dash-relay">{relayHost(pc.relay ?? defaultRelay)}</td>
                    <td className="relay-dash-seen">{pc.listed ? lastSeen(pc.last_seen_at) : "—"}</td>
                    <td className="relay-dash-act">{action(pc)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {shown.length === 0 && <p className="relay-dash-quiet relay-dash-none" data-filter-empty="">{t("No PC matches this filter.")}</p>}
        </div>
        {selectedPc && (
          <aside className="relay-dash-details" data-pc-details={selectedPc.server_id} aria-label={selectedPc.name}>
            <header className="relay-dash-details-bar"><StatusDot state={DOT_STATE[selectedPc.state]} /><h3 className="relay-dash-details-title" title={selectedPc.name}>{selectedPc.name}</h3><button type="button" className="icon-button" aria-label={t("Close")} onClick={() => navigateTo(formatDashboardHash({ view: "pcs", filter: activeFilter, relay: route.relay, pc: null }))}><X aria-hidden="true" /></button></header>
            <dl className="relay-dash-details-dl"><dt>{t("State")}</dt><dd>{accountPcStateText(selectedPc, t)}</dd><dt>{t("Relay")}</dt><dd><code>{relayHost(selectedPc.relay ?? defaultRelay)}</code></dd><dt>{t("Last seen")}</dt><dd>{selectedPc.listed ? lastSeen(selectedPc.last_seen_at) : "—"}</dd></dl>
            {selectedPc.paired && <div className="relay-dash-details-actions"><a className="btn" href={scope(selectedPc)}>{t("Open")}</a></div>}
          </aside>
        )}
      </div>
    </section>
  );

  const renderFleetView = (): ReactNode => {
    if (pcs === null || model === null) {
      return <>{route.view === "overview" && waiting && <div className="relay-dash-notice"><StatusDot state="needs-you" /><p>{fresh.has(waiting.server_id) ? t("{name} is new in your account. Type the number it shows on its own screen to add it.", { name: waiting.name }) : t("{name} has not approved this device yet.", { name: waiting.name })}</p>{action(waiting)}</div>}<div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /><span className="visually-hidden">{t("Loading your PCs…")}</span></div></>;
    }
    if (pcs.length === 0) {
      return <div className="relay-dash-empty" data-dashboard-empty=""><p>{t("No PCs yet. Sign in on a PC, or scan the QR code it shows, to see it here.")}</p><button type="button" className="btn btn-primary" onClick={onAddPc}>{t("Add a PC")}</button></div>;
    }
    if (route.view === "relay") {
      return (
        <>
          <section className="relay-dash-map" data-slot="relay-map" aria-labelledby="relay-dash-map-title"><h2 className="relay-dash-h" id="relay-dash-map-title">{t("Connection map")}</h2><RelayMap map={model.map} /></section>
          <section className="relay-dash-panel" id="relay-dash-relays" aria-labelledby="relay-dash-relays-title">
            <h2 className="relay-dash-h" id="relay-dash-relays-title">{t("Relays")}</h2>
            <ul className="relay-dash-relays">{model.map.hubs.map((hub) => (<li key={hub.origin}><button type="button" className="relay-dash-relay-filter" onClick={() => navigateTo(formatDashboardHash({ view: "pcs", relay: hub.origin }))}><code className="relay-dash-host">{relayHost(hub.origin)}</code></button><span>{hub.nodes.length === 1 ? t("1 PC") : t("{count} PCs", { count: hub.nodes.length })}</span><span>{model.relays.find((relay) => relay.origin === hub.origin)?.regional ? t("regional") : t("global")}</span></li>))}</ul>
          </section>
        </>
      );
    }
    if (route.view === "pcs") return renderTable(pcs);
    return (
      <>
        {waiting && <div className="relay-dash-notice"><StatusDot state="needs-you" /><p>{fresh.has(waiting.server_id) ? t("{name} is new in your account. Type the number it shows on its own screen to add it.", { name: waiting.name }) : t("{name} has not approved this device yet.", { name: waiting.name })}</p>{action(waiting)}</div>}
        <section className="relay-dash-summary" aria-label={t("Summary")}>
          <div className="relay-dash-cell"><h2 className="relay-dash-h">{t("PCs")}</h2><ul className="relay-dash-counts"><li><StatusDot state="ready" />{pcStateWord("paired", t)}<b>{model.counts.ready}</b></li><li><StatusDot state="needs-you" />{t("Needs you")}<b>{model.counts.needsYou}</b></li><li><StatusDot state="offline" />{pcStateWord("offline", t)}<b>{model.counts.offline}</b></li></ul></div>
          <div className="relay-dash-cell" id="relay-dash-relays"><h2 className="relay-dash-h">{t("Relays")}</h2><ul className="relay-dash-relays">{model.map.hubs.map((hub) => (<li key={hub.origin}><code className="relay-dash-host">{relayHost(hub.origin)}</code><span>{hub.nodes.length === 1 ? t("1 PC") : t("{count} PCs", { count: hub.nodes.length })}</span><span>{model.relays.find((relay) => relay.origin === hub.origin)?.regional ? t("regional") : t("global")}</span></li>))}</ul></div>
          <div className="relay-dash-cell relay-dash-cell-attention">
            <h2 className="relay-dash-h">{t("Needs attention · {count}", { count: model.attention.length })}</h2>
            {model.attention.length === 0 ? <p className="relay-dash-quiet">{t("Nothing needs you right now.")}</p> : <ul className="relay-dash-attention">{model.attention.flatMap(({ server_id }) => { const pc = byId.get(server_id); return pc ? [<li key={server_id}><StatusDot state={DOT_STATE[pc.state]} /><span><span className="relay-dash-attention-name" title={pc.name}>{pc.name}</span><small>{accountPcStateText(pc, t)}</small></span></li>] : []; })}</ul>}
          </div>
        </section>
        {renderTable(pcs)}
        <a className="relay-dash-map-disclosure" href="#relay" onClick={(e) => { e.preventDefault(); navigateTo("#relay"); }}><Waypoints aria-hidden="true" /><span>{t("Connection map")}</span><ChevronRight aria-hidden="true" /></a>
      </>
    );
  };

  return (
    <div className="relay-dash" data-dashboard-mode={account ? "account" : "local"} data-dashboard-view={route.view}>
      <aside className="relay-dash-side" aria-label={t("Navigation")}>
        <div className="relay-dash-side-box">
          <div className="relay-dash-brand-bar">
            <a className="relay-dash-brand" href="#overview" onClick={(e) => { e.preventDefault(); navigateTo("#overview"); }}><img src="/icons/icon-192.png?v=sheep1" alt="" className="relay-dash-brand-mark" />Ovis</a>
            {phone && <button type="button" className="icon-button relay-dash-phone-add" data-action="add-pc" aria-label={t("Add a PC")} onClick={onAddPc}><Plus aria-hidden="true" /></button>}
          </div>
          <nav className="relay-dash-nav" aria-label={t("Sections")}>{places.map((place) => <PlaceLink key={place.view} place={place} as="relay-dash-nav-item" onNavigate={navigateTo} />)}</nav>
          {!phone && <SidebarFoot account={account} {...(onSignIn ? { onSignIn } : {})} {...(onSignOut ? { onSignOut } : {})} />}
        </div>
      </aside>
      <div className="relay-dash-main" id="relay-dash-overview">
        <div className="relay-dash-content">
          <header className="relay-dash-top">
            <div className="relay-dash-top-text"><h1 ref={titleRef} className="relay-dash-title" tabIndex={-1}>{viewTitles[route.view]}</h1></div>
            {!phone && <button type="button" className="btn btn-primary" data-action="add-pc" onClick={onAddPc}><Plus aria-hidden="true" />{t("Add a PC")}</button>}
          </header>
          {route.view === "devices" ? <DevicesSection meLabel={meLabel} account={account} {...(onSignIn ? { onSignIn } : {})} {...(onSignOut ? { onSignOut } : {})} {...(onLeave ? { onLeave } : {})} />
            : route.view === "settings" ? <SettingsSection />
            : renderFleetView()}
          {error !== null && <p className="account-error" data-directory-error="" role="alert">{error}</p>}
        </div>
      </div>
      <nav className="relay-dash-tabs" aria-label={t("Sections")}>{places.map((place) => <PlaceLink key={place.view} place={place} as="relay-dash-tab" onNavigate={navigateTo} />)}</nav>
    </div>
  );
}
