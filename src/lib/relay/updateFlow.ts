/** Admitted version observations and the PC's supervised update lifecycle. */
import { MIN_SERVER_VERSION, MuxProtocolError } from "../../../shared/relay-mux.ts";
import type { UpdateStatus } from "../../../shared/update.ts";
import { fetchUpdateStatus, requestUpdate } from "../api.ts";
import { requestFreshShell } from "../shellMode.ts";
import { setTransport } from "../transport.ts";
import { relaySkew, reloadOnce } from "./skew.ts";
import type { ReloadMemory } from "./skew.ts";
import type { Attempt, PcUpdate, RelayShellState } from "./shellState.ts";
import type { RelayTransport } from "./transport.ts";
import { indexedDeviceStore, type RelayDeviceStore } from "./device.ts";

const UPDATE_MS = 15 * 60_000;
/** How often the shell reads the PC's update status while it installs. */
const UPDATE_POLL_MS = 1000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function reloadPage(serverId: string | null): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    // a worker check that hangs must not keep the stale shell up: the reload goes on without it
    await Promise.race([registration?.update(), wait(5000)]);
  } catch (error) { console.warn("Ovis: the service worker did not check for a newer shell", error); }
  if (serverId !== null) await freshShellNext(serverId);
  window.location.reload();
}

export async function freshShellNext(serverId: string): Promise<void> {
  try { await requestFreshShell(caches, serverId); } catch (error) { console.warn("Ovis: the worker was not asked for a fresh shell", error); }
}

function tabMemory(): ReloadMemory | null {
  try { return window.sessionStorage; } catch { return null; }
}


export interface ObservedVersion { readonly version: string; readonly outdated: boolean }
const VERSION_KEY = "ovis-relay-versions";
export function observedVersions(): ReadonlyMap<string, ObservedVersion> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(VERSION_KEY) ?? "[]");
    if (!Array.isArray(value)) return new Map();
    const entries: [string, ObservedVersion][] = [];
    for (const item of value) {
      if (Array.isArray(item) && typeof item[0] === "string" && /^[0-9a-f]{32}$/.test(item[0]) && typeof item[1] === "object" && item[1] !== null
        && typeof item[1].version === "string" && typeof item[1].outdated === "boolean") entries.push([item[0], { version: item[1].version, outdated: item[1].outdated }]);
    }
    return new Map(entries);
  } catch { return new Map(); }
}

/** Forget discards this PC's pairing and its tab-local admission observations together. */
export async function forgetSavedPc(serverId: string, store: RelayDeviceStore = indexedDeviceStore): Promise<void> {
  await store.remove(serverId);
  const versions = new Map(observedVersions());
  versions.delete(serverId);
  try { sessionStorage.setItem(VERSION_KEY, JSON.stringify([...versions])); } catch { /* tab storage may be unavailable */ }
}

export function createUpdateFlow(shellVersion: string, view: {
  readonly show: (state: RelayShellState) => void;
  readonly accepted: (opened: RelayTransport, attempt: Attempt) => void;
  readonly failed: (error: unknown, attempt: Attempt) => Promise<void>;
  readonly reload: () => Promise<void>;
}) {
  let outdated: { opened: RelayTransport; attempt: Attempt; name: string | null; version: string } | null = null;
  let updating = false;
  const { show, failed, reload } = view;
  const admit = async (opened: RelayTransport, attempt: Attempt): Promise<void> => {
    const server = opened.server ?? { version: "", relayProtocol: 0 };
    const skew = relaySkew({ server, shellVersion });
    if (skew === "protocol-mismatch") {
      opened.close();
      await failed(new MuxProtocolError("unsupported_version", `The PC speaks relay protocol ${server.relayProtocol}`), attempt);
      return;
    }
    const versions = new Map(observedVersions());
    versions.set(attempt.offer.server_id, { version: server.version, outdated: skew === "pc-outdated" });
    try { sessionStorage.setItem(VERSION_KEY, JSON.stringify([...versions])); } catch { /* unavailable storage loses only display metadata */ }
    const memory = tabMemory();
    if (skew === "server-newer" && memory !== null && reloadOnce(memory, shellVersion, server.version)) { opened.close(); await reload(); return; }
    if (skew !== "pc-outdated") { outdated = null; view.accepted(opened, attempt); return; }
    setTransport(opened);
    outdated = { opened, attempt, name: attempt.offer.name ?? null, version: server.version };
    await offerUpdate(outdated);
  };
  const showUpdate = (on: NonNullable<typeof outdated>, update: PcUpdate): void => {
    if (outdated !== on) return;
    show({ kind: "outdated", name: on.name, serverVersion: on.version, minVersion: MIN_SERVER_VERSION, update });
  };

  /** The Update button only for an install the PC's supervisor manages (server/update-api.ts); the steps by hand otherwise. */
  const offerUpdate = async (on: NonNullable<typeof outdated>): Promise<void> => {
    showUpdate(on, { phase: "reading" });
    let status: UpdateStatus | null = null;
    try { status = await fetchUpdateStatus(); } catch (error) { console.warn("Ovis: the PC's update status could not be read", error); }
    showUpdate(on, status?.managed === true ? { phase: "offer" } : { phase: "manual" });
  };

  /** The status once a check or install the PC runs has settled, or the deadline passed. */
  const settled = async (on: NonNullable<typeof outdated>, deadline: number): Promise<UpdateStatus | null> => {
    for (;;) {
      if (outdated !== on) return null;
      const status = await fetchUpdateStatus();
      if (status.phase !== "checking") return status;
      if (Date.now() > deadline) throw new Error("The PC's update check did not finish");
      await wait(UPDATE_POLL_MS);
    }
  };

  /**
   * Installs the release on offer on the PC (POST /api/updates/install, as Settings → Updates does),
   * then follows GET /api/updates until the restarted server answers through the relay: the
   * transport reconnects by itself, and its WELCOME names the new version.
   */
  const runUpdate = async (on: NonNullable<typeof outdated>): Promise<void> => {
    const deadline = Date.now() + UPDATE_MS;
    showUpdate(on, { phase: "installing", step: null });
    let status = await fetchUpdateStatus();
    if (outdated !== on) return;
    if (!status.available || status.latest_revision === null) {
      await requestUpdate({ command: "check" });
      const checked = await settled(on, deadline);
      if (checked === null) return;
      status = checked;
    }
    if (outdated !== on) return;
    if (!status.available || status.latest_revision === null) throw new Error(status.blocked_reason ?? status.error ?? "No update is on offer");
    await requestUpdate({ command: "install", expected_revision: status.latest_revision });
    for (;;) {
      await wait(UPDATE_POLL_MS);
      if (outdated !== on) return;
      if (Date.now() > deadline) throw new Error("The PC did not come back with the update");
      if (on.opened.server !== undefined && on.opened.server.version !== on.version) break;
      let now: UpdateStatus;
      try { now = await fetchUpdateStatus(); } catch {
        // the server is restarting: the relay carrier dropped, and the transport is reconnecting
        showUpdate(on, { phase: "restarting" });
        continue;
      }
      if (now.phase === "error") throw new Error(now.error ?? "The update failed");
      showUpdate(on, now.phase === "restarting" ? { phase: "restarting" } : { phase: "installing", step: now.step ?? null });
    }
    // the pairing code, if the attempt had one, was spent on the admission before the update
    if (outdated === on) await admit(on.opened, { ...on.attempt, code: false, paired: true });
  };

  const update = (): void => {
    const on = outdated;
    if (on === null || updating) return;
    updating = true;
    void runUpdate(on).catch((error: unknown) => {
      showUpdate(on, { phase: "failed", detail: error instanceof Error ? error.message : null });
    }).finally(() => { updating = false; });
  };


  return { admit, update, cancel: () => { outdated = null; } };
}
