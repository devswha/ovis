import "./RelayDashboard.css";

import { useState } from "react";
import { LayoutGrid, Monitor, Plus, Settings, Smartphone, Waypoints } from "lucide-react";
import type { ReactNode } from "react";

import { newPcs, type MyPc } from "../lib/account/myPcs.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import { dashboardModel, relayHost, type DashboardPc } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { accountPcStateText, CheckPcsButton, pcStateWord, PcStatusLine, PROVIDER_NAMES, ProviderMark } from "./AccountPcs.tsx";

/** Which of the two join flows the Add-a-PC sheet opens in: a PC new in the account types its digits; another PC of the account asks its members. */
export type SheetMode = "new" | "join";

type Filter = "all" | "ready" | "needs";

export interface RelayDashboardProps {
  /** every PC with the relay it goes through (dashboardPcs); null while the account's directory loads */
  pcs: readonly DashboardPc[] | null;
  /** signed in: the provider, named in the sidebar's foot with Sign out and Remove this device; null in local mode (this device's pairings alone), whose foot offers the sign-in */
  account: { provider: AccountProvider } | null;
  /** the shell's default relay origin, where a PC with no known relay is placed */
  defaultRelay: string;
  /** this device, as the map names it */
  meLabel: string;
  /** what the account service said went wrong, under the table; the pairings work regardless */
  error?: string | null;
  /** how each saved PC answered the latest check (pcStatus.ts), and Check now */
  pcStatus?: ReadonlyMap<string, PcStatus>;
  onCheckPcs?: () => void;
  /** Add a PC: the top bar's one primary action, and the empty state's */
  onAddPc: () => void;
  /** Add (a PC new in the account) or Join (another PC of the account that has not approved this device): the step sheet in that mode */
  onOpenSheet: (pc: MyPc, mode: SheetMode) => void;
  /** local mode: back to the sign-in */
  onSignIn?: () => void;
  /** ends the sign-in; every pairing stays */
  onSignOut?: () => void;
  /** removes this device from every PC of the account, then signs out */
  onLeave?: () => void;
}

/** A state's dot: the colour helps the eye, the words beside it carry the state (AccountPcs.css draws the same four). */
function StateDot({ state }: { state: MyPc["state"] }) {
  return <span className="relay-dash-dot" data-pc-state={state} aria-hidden="true" />;
}

/** The sidebar's foot: who is signed in, with Sign out and the way out of the account; or, without an account, the way in. */
function Foot({ account, onSignIn, onSignOut, onLeave }: Pick<RelayDashboardProps, "account" | "onSignIn" | "onSignOut" | "onLeave">) {
  const t = useT();
  const [leaving, setLeaving] = useState(false);
  if (account === null) {
    return (
      <div className="relay-dash-foot" id="relay-dash-device">
        <p className="relay-dash-who"><Smartphone aria-hidden="true" /><span>{t("Without an account")}</span></p>
        {onSignIn && <button type="button" className="btn" onClick={onSignIn}>{t("Sign in")}</button>}
      </div>
    );
  }
  return (
    <div className="relay-dash-foot" id="relay-dash-device">
      <p className="relay-dash-who"><ProviderMark provider={account.provider} /><span>{t("Signed in with {provider}", { provider: PROVIDER_NAMES[account.provider] })}</span></p>
      {leaving && onLeave ? (
        <>
          <p className="account-fineprint">{t("Every PC of the account removes this device. You can pair it again later.")}</p>
          <button type="button" className="btn btn-danger" onClick={onLeave}>{t("Remove this device")}</button>
          <button type="button" className="btn" onClick={() => setLeaving(false)}>{t("Cancel")}</button>
        </>
      ) : (
        <>
          {onSignOut && <button type="button" className="account-link" onClick={onSignOut}>{t("Sign out")}</button>}
          {onLeave && <button type="button" className="account-link account-link-danger" onClick={() => setLeaving(true)}>{t("Remove this device from your account")}</button>}
        </>
      )}
    </div>
  );
}

/**
 * The front page once signed in, or with this device's own pairings and no account (local mode):
 * a sidebar, the summary of the account's PCs (dashboardModel), the slot the connection map
 * mounts in, and one row per PC with the one thing to do with it. Its words come from the account
 * directory and this device's pairings alone: nothing here is a live connection (lib/relay/dashboard.ts).
 * Layout after GOAT's Fleet console (a telemetry strip over the machines) and Tailscale's machine
 * list for the table; the states and their words are this app's (AccountPcs.tsx).
 */
export function RelayDashboard({ pcs, account, defaultRelay, meLabel, error = null, pcStatus, onCheckPcs, onAddPc, onOpenSheet, onSignIn, onSignOut, onLeave }: RelayDashboardProps) {
  const t = useT();
  const [filter, setFilter] = useState<Filter>("all");
  const model = pcs === null ? null : dashboardModel(pcs, { label: meLabel }, defaultRelay);
  const fresh = new Set(pcs === null ? [] : newPcs(pcs, Date.now()).map((pc) => pc.server_id));
  const byId = new Map((pcs ?? []).map((pc) => [pc.server_id, pc]));
  const waiting = pcs?.find((pc) => pc.state === "needs-approval");
  const shown = (pcs ?? []).filter((pc) => filter === "all" || (filter === "ready" ? pc.state === "paired" : pc.state === "needs-approval" || pc.state === "needs-update"));
  const scope = (pc: MyPc): string => serverScopePath(pc.server_id);

  /** What a row offers: the one action its state allows, or nothing while it waits on someone else. */
  const action = (pc: DashboardPc): ReactNode => {
    switch (pc.state) {
      case "paired": return <a className="btn btn-primary" href={scope(pc)}>{t("Open")}</a>;
      case "needs-approval":
        if (pc.join === undefined) return null;
        return fresh.has(pc.server_id)
          ? <button type="button" className="btn" onClick={() => onOpenSheet(pc, "new")}>{t("Add")}</button>
          : <button type="button" className="btn" onClick={() => onOpenSheet(pc, "join")}>{t("Join")}</button>;
      // its own page runs the update (the shell's outdated screen) and says what an offline PC did last
      case "needs-update": return pc.paired ? <a className="btn" href={scope(pc)}>{t("Update")}</a> : null;
      case "offline": return pc.paired ? <a className="btn" href={scope(pc)}>{t("Details")}</a> : null;
    }
  };
  const subtitle = pcs === null ? null : account
    ? pcs.length === 1 ? t("1 PC in your account") : t("{count} PCs in your account", { count: pcs.length })
    : pcs.length === 1 ? t("1 PC paired with this device") : t("{count} PCs paired with this device", { count: pcs.length });
  const under = (pc: DashboardPc): string => pc.listed ? (fresh.has(pc.server_id) ? t("new in your account") : t("in your account"))
    : account ? t("paired by QR · not in the account yet") : t("paired with this device");

  return (
    <div className="relay-dash" data-dashboard-mode={account ? "account" : "local"}>
      <aside className="relay-dash-side">
        <p className="relay-dash-brand"><img src="/icons/icon-192.png?v=sheep1" alt="" className="relay-dash-brand-mark" />Ovis</p>
        <nav className="relay-dash-nav">
          <a className="relay-dash-nav-item" href="#relay-dash-overview" aria-current="page"><LayoutGrid aria-hidden="true" />{t("Overview")}</a>
          <a className="relay-dash-nav-item" href="#relay-dash-pcs"><Monitor aria-hidden="true" />{t("PCs")}{pcs !== null && pcs.length > 0 && <span className="relay-dash-nav-count">{pcs.length}</span>}</a>
          <a className="relay-dash-nav-item" href="#relay-dash-device"><Smartphone aria-hidden="true" />{t("Devices")}</a>
          <a className="relay-dash-nav-item" href="#relay-dash-relays"><Waypoints aria-hidden="true" />{t("Relay")}</a>
          {/* no settings on this screen yet: the row keeps its place and says it is not a link */}
          <span className="relay-dash-nav-item" aria-disabled="true"><Settings aria-hidden="true" />{t("Settings")}</span>
        </nav>
        <Foot account={account} {...(onSignIn ? { onSignIn } : {})} {...(onSignOut ? { onSignOut } : {})} {...(onLeave ? { onLeave } : {})} />
      </aside>
      <div className="relay-dash-main" id="relay-dash-overview">
        <header className="relay-dash-top">
          <div className="relay-dash-top-text">
            <h1 className="relay-dash-title">{t("Overview")}</h1>
            {subtitle !== null && <p className="relay-dash-sub">{subtitle}</p>}
          </div>
          <button type="button" className="btn btn-primary" onClick={onAddPc}><Plus aria-hidden="true" />{t("Add a PC")}</button>
        </header>
        {waiting && (
          <div className="relay-dash-notice">
            <StateDot state="needs-approval" />
            <p>{fresh.has(waiting.server_id)
              ? t("{name} is new in your account. Type the number it shows on its own screen to add it.", { name: waiting.name })
              : t("{name} has not approved this device yet.", { name: waiting.name })}</p>
            {action(waiting)}
          </div>
        )}
        {pcs === null || model === null ? (
          <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /><span className="visually-hidden">{t("Loading your PCs…")}</span></div>
        ) : pcs.length === 0 ? (
          <div className="relay-dash-empty">
            <p>{t("No PCs yet. Sign in on a PC, or scan the QR code it shows, to see it here.")}</p>
            <button type="button" className="btn btn-primary" onClick={onAddPc}>{t("Add a PC")}</button>
          </div>
        ) : (
          <>
            <section className="relay-dash-summary" aria-label={t("Summary")}>
              <div className="relay-dash-cell">
                <h2 className="relay-dash-h">{t("PCs")}</h2>
                <ul className="relay-dash-counts">
                  <li><StateDot state="paired" />{pcStateWord("paired", t)}<b>{model.counts.ready}</b></li>
                  <li><StateDot state="needs-approval" />{t("Needs you")}<b>{model.counts.needsYou}</b></li>
                  <li><StateDot state="offline" />{pcStateWord("offline", t)}<b>{model.counts.offline}</b></li>
                </ul>
              </div>
              <div className="relay-dash-cell" id="relay-dash-relays">
                <h2 className="relay-dash-h">{t("Relays")}</h2>
                <ul className="relay-dash-relays">
                  {/* in the map's order (map.hubs: the busiest first), so the strip and the map read the same */}
                  {model.map.hubs.map((hub) => (
                    <li key={hub.origin}>
                      <code className="relay-dash-host">{relayHost(hub.origin)}</code>
                      <span>{hub.nodes.length === 1 ? t("1 PC") : t("{count} PCs", { count: hub.nodes.length })}</span>
                      <span>{model.relays.find((relay) => relay.origin === hub.origin)?.regional ? t("regional") : t("global")}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="relay-dash-cell relay-dash-cell-attention">
                <h2 className="relay-dash-h">{t("Needs attention · {count}", { count: model.attention.length })}</h2>
                {model.attention.length === 0
                  ? <p className="relay-dash-quiet">{t("Nothing needs you right now.")}</p>
                  : <ul className="relay-dash-attention">
                    {model.attention.map(({ server_id }) => { const pc = byId.get(server_id)!; return (
                      <li key={server_id}><StateDot state={pc.state} /><span><span className="relay-dash-attention-name">{pc.name}</span><small>{accountPcStateText(pc, t)}</small></span></li>
                    ); })}
                  </ul>}
              </div>
            </section>
            {/* the connection map (RelayMap.tsx) mounts here from model.map; nothing is drawn until it does */}
            <div className="relay-dash-map" data-slot="relay-map" />
            <section className="relay-dash-pcs" id="relay-dash-pcs" aria-labelledby="relay-dash-pcs-title">
              <div className="relay-dash-pcs-head">
                <h2 id="relay-dash-pcs-title">{t("PCs")}</h2>
                {onCheckPcs && pcs.some((pc) => pc.paired) && <CheckPcsButton status={pcStatus ?? new Map()} onCheck={onCheckPcs} />}
                <div className="segmented" role="group" aria-label={t("Filter")}>
                  <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>{t("All")}</button>
                  <button type="button" aria-pressed={filter === "ready"} onClick={() => setFilter("ready")}>{pcStateWord("paired", t)}</button>
                  <button type="button" aria-pressed={filter === "needs"} onClick={() => setFilter("needs")}>{t("Needs you")}</button>
                </div>
              </div>
              <table className="relay-dash-table">
                <colgroup><col className="relay-dash-col-name" /><col className="relay-dash-col-state" /><col className="relay-dash-col-relay" /><col className="relay-dash-col-seen" /><col className="relay-dash-col-act" /></colgroup>
                <thead>
                  <tr><th scope="col">{t("Name")}</th><th scope="col">{t("State")}</th><th scope="col">{t("Relay")}</th><th scope="col">{t("Last seen")}</th><th scope="col"><span className="visually-hidden">{t("Action")}</span></th></tr>
                </thead>
                <tbody>
                  {shown.map((pc) => (
                    <tr key={pc.server_id} data-pc-state={pc.state}>
                      <td>
                        <div className="relay-dash-name">
                          <span className="relay-dash-name-icon" aria-hidden="true"><Monitor /></span>
                          <span className="relay-dash-name-text"><b>{pc.name}</b><small>{under(pc)}</small></span>
                        </div>
                      </td>
                      <td>
                        {pc.paired && pcStatus?.get(pc.server_id)
                          ? <PcStatusLine status={pcStatus.get(pc.server_id)!} lastSeenAt={pc.last_seen_at} />
                          : <span className="relay-dash-state"><StateDot state={pc.state} />{pcStateWord(pc.state, t)}</span>}
                      </td>
                      <td className="relay-dash-relay">{relayHost(pc.relay ?? defaultRelay)}</td>
                      <td className="relay-dash-seen">{pc.listed ? lastSeen(pc.last_seen_at) : "—"}</td>
                      <td className="relay-dash-act">{action(pc)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown.length === 0 && <p className="relay-dash-quiet relay-dash-none">{t("No PC matches this filter.")}</p>}
            </section>
          </>
        )}
        {error !== null && <p className="account-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
