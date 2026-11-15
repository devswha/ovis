/** Session selection and repeatable checks for an engine whose lifetime belongs to its owner. */
import { homedir } from "node:os";
import { join } from "node:path";
import type { FleetBridgeHealth } from "../../shared/machines.ts";
import { finishHerdrIdentity, herdrLifetime } from "../finishes.ts";
import { chosenHerdrSocketStatus, discoverHerdrSessions, validHerdrSocket } from "../herdr-discovery.ts";
import { ping } from "../herdr/client.ts";
import { sidecarAvailable } from "../pty/sidecar.ts";
import { coreProductEngine } from "./core-product-engine.ts";
import { versionText } from "./machine-bridge-common.ts";

/** The entry chooses its runtime and sets its lifecycle policy before constructing services. */
export function productEngine(stateDir: string, runtimeId: string, isCore: boolean) {
  const named = isCore ? undefined : process.env["HERDR_REMOTE_SESSION"];
  const socket = isCore ? undefined : process.env["HERDR_REMOTE_SOCKET"];
  const badSetting = named && !/^[A-Za-z0-9_-]{1,64}$/.test(named)
    ? "HERDR_REMOTE_SESSION must name a herdr session (1-64 letters, digits, underscores or hyphens)."
    : socket && !validHerdrSocket(socket) ? "HERDR_REMOTE_SOCKET must be an absolute path ending in /herdr.sock." : null;
  let selected = badSetting ? null : socket || (named ? join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr", "sessions", named, "herdr.sock") : null);
  const health: FleetBridgeHealth = {
    engine: isCore ? "herdr-core" : "herdr", terminal_mode: isCore || sidecarAvailable() ? "attach" : "mirror", socket_path: selected, runtime_id: runtimeId, boot_id: isCore ? "awaiting-herdr-core" : "awaiting-herdr", runtime_down: true,
    reason: "herdr_session_gone", message: "herdr is not running on this machine for the selected session.",
  };
  const unavailable = join(stateDir, "unavailable", "herdr.sock");
  process.env["HERDR_SOCKET"] = unavailable;
  const core = isCore ? coreProductEngine(health, unavailable) : undefined;
  let runtimeVersion = isCore ? "herdr-core-unknown" : "herdr-unknown";
  let stopped = false;
  let eventsReady = false;
  let refreshStatus: (() => void) | undefined;
  let lastMessage: string | null = null;
  return {
    health, unavailable,
    /** Connect after the initial probe and server construction, before starting rechecks. */
    watchStatus(ready: Promise<void>, refresh: () => void) {
      refreshStatus = refresh;
      void ready.then(() => { eventsReady = true; });
    },
    async probe(): Promise<string> {
      if (core) {
        runtimeVersion = await core.probe();
      } else {
        let reason: FleetBridgeHealth["reason"] = badSetting ? "herdr_setting_invalid" : "herdr_session_gone";
        let message: string | null = badSetting ?? "herdr is not running on this machine for the selected session.";
        if (selected === null && !badSetting) {
          const found = await discoverHerdrSessions();
          if (found.length === 1) selected = found[0]!.socket_path;
          else if (found.length > 1) {
            reason = "herdr_sessions_found";
            message = "Several herdr sessions are running on this machine. Select one with HERDR_REMOTE_SOCKET.";
          }
        }
        if (selected !== null) {
          const status = await chosenHerdrSocketStatus(selected);
          if (status === "refused") {
            reason = "herdr_socket_refused";
            message = "The selected herdr socket cannot be used safely by this account.";
          } else if (status === "usable") {
            try {
              const info = await ping(selected, 1500);
              if (info.protocol < 22) {
                reason = "herdr_unsupported";
                message = "herdr 0.9 or newer is required. Update it explicitly before using this fleet bridge.";
              } else {
                const identity = finishHerdrIdentity(selected);
                if (identity !== null) {
                  health.boot_id = herdrLifetime(identity);
                  runtimeVersion = `herdr-${versionText(info.version)}`;
                  reason = null;
                  message = null;
                }
              }
            } catch { /* keep serving health while the selected engine is unavailable */ }
          }
        }
        if (stopped) return runtimeVersion;
        process.env["HERDR_SOCKET"] = reason === null ? selected! : unavailable;
        health.socket_path = selected;
        health.reason = reason;
        health.message = message;
        health.runtime_down = reason !== null;
      }
      if (stopped) return runtimeVersion;
      if (refreshStatus && !health.runtime_down && !eventsReady) {
        // A second subscribe on an existing herdr connection is ignored. Refresh opens the full
        // pane set on a new connection; rechecks still detect engine death while it is pending.
        refreshStatus();
        health.reason = isCore ? "hc_connecting" : "herdr_connecting";
        health.message = `Waiting for the selected ${health.engine} session's status subscriptions.`;
        health.runtime_down = true;
      }
      if (health.message !== lastMessage) { if (health.message) console.error(health.message); lastMessage = health.message; }
      return runtimeVersion;
    },
    stop() { stopped = true; core?.stop(); },
  };
}
