import type { ReactNode } from "react";
import { currentLocale, type Translate } from "../lib/i18n.ts";
import { relayHost, type dashboardModel } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import type { StatusDotState } from "./StatusDot.tsx";

export type DashboardRow = ReturnType<typeof dashboardModel>["rows"][number];

/**
 * The state a PC's surfaces follow (the table, Details and the map alike): the directory's, except
 * that a live answer from this device beats the directory's stale Offline, since the PC is reachable
 * now. Needs approval and Needs update stay even when it answered: both are true, and the route
 * cell carries the answer.
 */
export function liveState(pc: Pick<DashboardRow, "state" | "check">): DashboardRow["state"] {
  return pc.state === "offline" && pc.check?.kind === "answered" ? "paired" : pc.state;
}

/** The glyph follows the live state; only a paired PC the account does not list falls back to this device's own check, the one fact there is about it. */
export function pcDotState(row: DashboardRow, updating = false, mode: "account" | "local" = "account"): StatusDotState {
  if (updating) return "updating";
  if (row.check?.kind === "checking") return "checking";
  switch (liveState(row)) {
    case "needs-approval": case "needs-update": return "needs-you";
    case "offline": return "offline";
    case "paired": return mode === "local" || !row.listed ? (row.check?.kind === "answered" ? "ready" : "offline") : "ready";
  }
}

/** The state word of a paired PC the account does not list: what this device's own check found, since no directory speaks for it; the Relay cell carries the way and the round trip. */
export function localStateWord(check: PcStatus | null, t: Translate): string {
  if (check === null) return t("Paired · not checked");
  if (check.kind === "checking") return t("Checking…");
  return check.kind === "answered" ? t("Answers") : t("No answer");
}

export function formatAbsoluteTime(iso: string): string {
  try { return new Date(iso).toLocaleString(currentLocale()); } catch { return iso; }
}

export function formatProbeLine(check: PcStatus | null, t: Translate): string | null {
  if (check === null) return null;
  if (check.kind === "checking") return t("Checking…");
  if (check.kind === "answered") return t("This device: answered · {n} ms", { n: check.rttMs });
  return t("This device: no answer");
}

/** One short label for how this device reaches a PC right now, as GOAT lists each environment's routes: the way (the same network, Tailscale, or the host of the relay that answered) with its round trip, or why there is none. */
export function routeText(check: PcStatus | null, t: Translate): string {
  if (check === null) return t("Not checked");
  if (check.kind === "checking") return t("Checking…");
  if (check.kind === "offline") return t("No answer");
  const way = check.route === "lan" ? t("Same network") : check.route === "tailscale" ? "Tailscale" : check.relay === undefined ? t("Relay") : relayHost(check.relay);
  return `${way} · ${t("{n} ms", { n: check.rttMs })}`;
}

/** routeText as a one-line cell: the answering relay's host as its chip, the round trip in tabular figures, the state colour left to the dot. */
export function routeNode(check: PcStatus | null, t: Translate): ReactNode {
  const text = routeText(check, t);
  const relayed = check?.kind === "answered" && check.route === "relay" && check.relay !== undefined ? { host: relayHost(check.relay), ms: check.rttMs } : null;
  return <span className="relay-pc-route" data-route={check === null ? "unchecked" : check.kind === "answered" ? check.route : check.kind} title={text}>
    {relayed === null ? <span>{text}</span> : <><code className="relay-pc-relay-chip">{relayed.host}</code><span>{` · ${t("{n} ms", { n: relayed.ms })}`}</span></>}
  </span>;
}
