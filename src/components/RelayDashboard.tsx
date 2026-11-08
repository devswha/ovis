import "./RelayDashboard.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LayoutGrid, Monitor, Plus, Settings, Smartphone, Waypoints, type LucideIcon } from "lucide-react";
import type { MyPc } from "../lib/account/myPcs.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { LANGUAGE_NAMES, LANGUAGE_SETTINGS, useT } from "../lib/i18n.ts";
import { dashboardModel, relayHost, type DashboardFilter, type DashboardPc } from "../lib/relay/dashboard.ts";
import { formatDashboardHash, isDashboardHash, parseDashboardHash, type DashboardRoute, type DashboardView } from "../lib/relay/dashboardRoute.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import type { ObservedVersion } from "../lib/relay/updateFlow.ts";
import { uiFontSize, useSettings } from "../lib/settings.ts";
import { UI_FONT_MAX, UI_FONT_MIN } from "../lib/typography.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { PROVIDER_NAMES, ProviderMark } from "./AccountPcs.tsx";
import { RelayMap } from "./RelayMap.tsx";
import { RelayOverview } from "./RelayOverview.tsx";
import { RelayPcDetails } from "./RelayPcDetails.tsx";
import { RelayPcTable } from "./RelayPcTable.tsx";
import { Segmented, SettingsBare, SettingsGroup, SettingsRow, SettingsSelect, Stepper } from "./SettingsControls.tsx";

const PHONE_QUERY = "(max-width: 768px)";
/** below this the details are a full view under the list (RelayPcDetails.css), not a side panel */
const NARROW_DETAILS_QUERY = "(max-width: 1099px)";

export interface RelayDashboardProps {
  pcs: readonly DashboardPc[] | null; account: { provider: AccountProvider } | null; defaultRelay: string; meLabel: string;
  error?: string | null; pcStatus?: ReadonlyMap<string, PcStatus>; observedVersions?: ReadonlyMap<string, ObservedVersion>;
  onCheckPcs?: () => void; onCheckPc?: (serverId: string) => void; onRefreshAccount?: () => void; onAddPc: () => void; onPairByQr?: () => void;
  onOpenSheet: (pc: MyPc, mode: "new" | "join") => void; onForgetPc?: (serverId: string) => Promise<void> | void;
  onSignIn?: () => void; onSignOut?: () => void; onLeave?: () => void;
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

export function RelayDashboard({
  pcs, account, defaultRelay, meLabel, error = null, pcStatus, observedVersions,
  onCheckPcs, onCheckPc, onRefreshAccount, onAddPc, onPairByQr, onOpenSheet, onForgetPc, onSignIn, onSignOut, onLeave,
}: RelayDashboardProps) {
  const t = useT(), phone = useMediaQuery(PHONE_QUERY), narrow = useMediaQuery(NARROW_DETAILS_QUERY);
  const mode: "account" | "local" = account ? "account" : "local";
  const [route, setRoute] = useState<DashboardRoute>(() => typeof window === "undefined" ? { view: "overview", filter: "all", relay: null, pc: null } : parseDashboardHash(window.location.hash));
  const [localFilter, setLocalFilter] = useState<DashboardFilter>("all");
  const [checkedByUser, setCheckedByUser] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null), prevViewRef = useRef<DashboardView>(route.view);
  const splitRef = useRef<HTMLDivElement>(null), prevPcRef = useRef<string | null>(route.pc);
  /** the PC whose details Back, Close or Escape just left: below 1100px its row takes the focus back */
  const closedPcRef = useRef<string | null>(null);

  useEffect(() => {
    const sync = () => { if (!window.location.hash || window.location.hash === "#" || isDashboardHash(window.location.hash)) setRoute(parseDashboardHash(window.location.hash)); };
    window.addEventListener("hashchange", sync); window.addEventListener("popstate", sync);
    return () => { window.removeEventListener("hashchange", sync); window.removeEventListener("popstate", sync); };
  }, []);

  useEffect(() => { if (prevViewRef.current !== route.view) { prevViewRef.current = route.view; titleRef.current?.focus(); } }, [route.view]);

  // On a phone the details replace the list (IS-TABLE-08), so the view starts at the top; between the phone and 1100px
  // they open under the whole list, so the panel scrolls into view. Either way the details heading takes the focus
  // (ringless, RelayDashboard.css) and leaving them focuses the row again. From 1100px the side panel opens beside the
  // list and the focus stays where the click put it.
  useEffect(() => {
    if (route.pc === prevPcRef.current) return;
    prevPcRef.current = route.pc;
    const closed = closedPcRef.current;
    closedPcRef.current = null;
    const split = splitRef.current;
    if (!narrow || split === null) return;
    if (route.pc !== null) {
      const details = split.querySelector<HTMLElement>("[data-pc-details]"), heading = details?.querySelector<HTMLElement>("h2");
      if (!details || !heading) return;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      if (phone) window.scrollTo(0, 0); else details.scrollIntoView({ block: "start" });
    } else if (closed !== null) {
      (split.querySelector<HTMLElement>(`[data-pc-id="${closed}"] .relay-pc-name-btn`) ?? titleRef.current)?.focus();
    }
  }, [route.pc, narrow, phone]);

  const navigateTo = (nextHash: string) => {
    setRoute(parseDashboardHash(nextHash));
    if (typeof window !== "undefined" && window.location.hash !== nextHash) window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
  };
  const activeFilter: DashboardFilter = route.view === "pcs" ? route.filter : localFilter;
  const setFilter = (next: DashboardFilter) => route.view === "pcs" ? navigateTo(formatDashboardHash({ view: "pcs", filter: next, relay: route.relay, pc: route.pc })) : setLocalFilter(next);
  const handleCheckPcs = onCheckPcs ? () => { setCheckedByUser(true); onCheckPcs(); } : undefined;

  const model = pcs === null ? null : dashboardModel(pcs, { label: meLabel, ...(pcStatus ? { status: pcStatus } : {}) }, defaultRelay);
  const rowById = new Map((model?.rows ?? []).map((row) => [row.server_id, row]));
  const selectedRow = route.view === "pcs" && route.pc !== null ? rowById.get(route.pc) ?? null : null;
  const selectPc = (serverId: string) => navigateTo(formatDashboardHash({ view: "pcs", filter: activeFilter, relay: route.relay, pc: serverId }));
  const closeDetails = () => { closedPcRef.current = route.pc; navigateTo(formatDashboardHash({ view: "pcs", filter: activeFilter, relay: route.relay, pc: null })); };

  const viewTitles: Record<DashboardView, string> = { overview: t("Overview"), pcs: t("PCs"), devices: t("Devices"), relay: t("Relay"), settings: t("Settings") };
  const places: Place[] = [
    { view: "overview", href: "#overview", Icon: LayoutGrid, label: viewTitles.overview, current: route.view === "overview", ...(model && model.counts.needsYou > 0 ? { count: model.counts.needsYou } : {}) },
    { view: "pcs", href: "#pcs", Icon: Monitor, label: viewTitles.pcs, current: route.view === "pcs", ...(pcs !== null && pcs.length > 0 ? { count: pcs.length } : {}) },
    { view: "devices", href: "#devices", Icon: Smartphone, label: viewTitles.devices, current: route.view === "devices" },
    { view: "relay", href: "#relay", Icon: Waypoints, label: viewTitles.relay, current: route.view === "relay" },
    { view: "settings", href: "#settings", Icon: Settings, label: viewTitles.settings, current: route.view === "settings" },
  ];

  const renderTableSection = (relayFilter: string | null) => model && (
    <section className="relay-dash-pcs" id="relay-dash-pcs" aria-label={t("PCs")}>
      <div ref={splitRef} className={selectedRow ? "relay-dash-pcs-split is-selected" : "relay-dash-pcs-split"}>
        {/* a phone shows one screen at a time: with a PC selected, its details stand in for the list until Back */}
        {!(phone && selectedRow) && (
          <div className="relay-dash-pcs-list">
            <RelayPcTable rows={model.rows} attention={model.attention} filters={model.filters} filter={activeFilter} onFilter={setFilter}
              relayFilter={relayFilter} onClearRelayFilter={() => navigateTo(formatDashboardHash({ view: "pcs", filter: activeFilter, relay: null, pc: route.pc }))}
              selectedPcId={selectedRow?.server_id ?? null} onSelect={selectPc} onOpenSheet={onOpenSheet} showLastSeen={selectedRow === null}
              {...(pcStatus ? { pcStatus } : {})} {...(handleCheckPcs ? { onCheckPcs: handleCheckPcs } : {})} checkedByUser={checkedByUser} mode={mode} />
          </div>
        )}
        {selectedRow && (
          <RelayPcDetails pc={selectedRow} observedVersion={observedVersions?.get(selectedRow.server_id) ?? null} mode={mode}
            onClose={closeDetails} onOpenSheet={onOpenSheet} {...(onForgetPc ? { onForget: onForgetPc } : {})} {...(onCheckPc ? { onCheckPc } : {})} />
        )}
      </div>
    </section>
  );

  const renderFleetView = (): ReactNode => {
    if (route.view === "relay") {
      if (pcs === null || model === null) {
        return <RelayOverview pcs={null} mode={mode} defaultRelay={defaultRelay} meLabel={meLabel} error={error} {...(onRefreshAccount ? { onRetryError: onRefreshAccount } : {})} />;
      }
      return (
        <>
          {error !== null && (
            <div className="relay-overview-banner" role="alert" data-directory-error="">
              <p className="relay-overview-banner-text">{error}</p>
              {onRefreshAccount && <button type="button" className="btn" data-action="retry-directory" onClick={onRefreshAccount}>{t("Try again")}</button>}
            </div>
          )}
          <section className="relay-dash-map" data-slot="relay-map" aria-labelledby="relay-dash-map-title">
            <h2 className="relay-dash-h" id="relay-dash-map-title">{t("Connection map")}</h2>
            <RelayMap map={model.map} selectedPcId={route.pc} onSelectPc={selectPc} onSelectRelay={(origin) => navigateTo(formatDashboardHash({ view: "pcs", relay: relayHost(origin) }))} standalone />
          </section>
          {model.map.hubs.length > 0 && (
            <section className="relay-dash-panel" id="relay-dash-relays" aria-labelledby="relay-dash-relays-title">
              <h2 className="relay-dash-h" id="relay-dash-relays-title">{t("Relays")}</h2>
              <ul className="relay-dash-relays">{model.map.hubs.map((hub) => (<li key={hub.origin}><button type="button" className="relay-dash-relay-filter" onClick={() => navigateTo(formatDashboardHash({ view: "pcs", relay: relayHost(hub.origin) }))}><code className="relay-dash-host">{relayHost(hub.origin)}</code></button><span>{hub.nodes.length === 1 ? t("1 PC") : t("{count} PCs", { count: hub.nodes.length })}</span><span>{model.relays.find((relay) => relay.origin === hub.origin)?.regional ? t("regional") : t("global")}</span></li>))}</ul>
            </section>
          )}
        </>
      );
    }
    if (route.view === "pcs" && pcs !== null && pcs.length > 0 && model !== null) {
      return (
        <>
          {error !== null && (
            <div className="relay-overview-banner" role="alert" data-directory-error="">
              <p className="relay-overview-banner-text">{error}</p>
              {onRefreshAccount && <button type="button" className="btn" data-action="retry-directory" onClick={onRefreshAccount}>{t("Try again")}</button>}
            </div>
          )}
          {renderTableSection(route.relay)}
        </>
      );
    }
    return (
      <RelayOverview pcs={pcs} mode={mode} defaultRelay={defaultRelay} meLabel={meLabel} error={error}
        {...(pcStatus ? { pcStatus } : {})} {...(observedVersions ? { observedVersions } : {})} activeFilter={activeFilter}
        onSelectFilter={(f) => navigateTo(formatDashboardHash({ view: "pcs", filter: f }))}
        onOpenRelay={(origin) => navigateTo(origin ? formatDashboardHash({ view: "pcs", relay: relayHost(origin) }) : "#relay")}
        {...(onRefreshAccount ? { onRetryError: onRefreshAccount } : {})} onAddPc={onAddPc} {...(onPairByQr ? { onPairByQr } : {})}
        onOpenSheet={onOpenSheet} onSelectPc={selectPc}>
        {pcs !== null && pcs.length > 0 && renderTableSection(null)}
      </RelayOverview>
    );
  };

  return (
    <div className="relay-dash" data-dashboard-mode={mode} data-dashboard-view={route.view}>
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
            {!phone && <button type="button" className={pcs?.length === 0 && (route.view === "overview" || route.view === "pcs") ? "btn" : "btn btn-primary"} data-action="add-pc" onClick={onAddPc}><Plus aria-hidden="true" />{t("Add a PC")}</button>}
          </header>
          {route.view === "devices" ? <DevicesSection meLabel={meLabel} account={account} {...(onSignIn ? { onSignIn } : {})} {...(onSignOut ? { onSignOut } : {})} {...(onLeave ? { onLeave } : {})} />
            : route.view === "settings" ? <SettingsSection />
            : renderFleetView()}
        </div>
      </div>
      <nav className="relay-dash-tabs" aria-label={t("Sections")}>{places.map((place) => <PlaceLink key={place.view} place={place} as="relay-dash-tab" onNavigate={navigateTo} />)}</nav>
    </div>
  );
}
