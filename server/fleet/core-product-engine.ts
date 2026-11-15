/** The selected native core, with no ownership of its process or its terminals. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { FleetBridgeHealth } from "../../shared/machines.ts";
import { finishHerdrIdentity, herdrLifetime } from "../finishes.ts";
import { coreSocket, coreSocketCandidates, coreSocketStatus, plainSession } from "../herdr-core/discovery.ts";
import { coreAnswers, coreConnection, NoHerdrCoreError, startRuntime } from "../herdr-core/runtime.ts";
import { capabilities, HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import { versionText } from "./machine-bridge-common.ts";

export function coreProductEngine(health: FleetBridgeHealth, unavailable: string) {
  const env = { ...process.env };
  const named = env["HC_SESSION"]?.trim();
  const requested = (env["HC_SOCKET"] || named) ? coreSocket({ env }).path : null;
  const badSetting = named && !plainSession(named)
    ? "HC_SESSION must name a herdr-core session (1-64 letters, digits, underscores, dots or hyphens, excluding . and ..)."
    : requested !== null && (!isAbsolute(requested) || /[\0\r\n]/.test(requested)) ? "HC_SOCKET must be an absolute native core socket path." : null;
  let selected = badSetting ? null : requested;
  health.socket_path = selected;
  // Background services also use coreConnection: until selection they must reach no default core.
  process.env["HC_SOCKET"] = selected ?? unavailable;
  let adapter: Awaited<ReturnType<typeof startRuntime>> = null;
  let adapterDir: string | undefined;
  let runtimeVersion = "herdr-core-unknown";
  let stopped = false;
  let saidRefusal: string | null = null;
  // The native stream implementation is available without a classic PTY host, even while the core is down.
  serveRuntime(HERDR_CORE);
  return {
    async probe(): Promise<string> {
      let reason: FleetBridgeHealth["reason"] = badSetting ? "hc_setting_invalid" : "hc_session_gone";
      let message: string | null = badSetting ?? "herdr-core is not running on this machine for the selected session.";
      if (selected === null && !badSetting) {
        try {
          const found = (await Promise.all(coreSocketCandidates(env).map(async (path) => {
            const checked = coreSocketStatus(path);
            return checked.status === "socket" && await coreAnswers(checked.real) ? path : null;
          }))).filter((path): path is string => path !== null);
          if (found.length === 1) selected = found[0]!;
          else if (found.length > 1) { reason = "hc_sessions_found"; message = "Several herdr-core sessions are running on this machine. Select one with HC_SOCKET or HC_SESSION."; }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM"))) throw error;
          reason = "hc_discovery_refused";
          message = "The herdr-core session directories cannot be read by this account. Check their permissions.";
        }
      }
      if (selected !== null) {
        const checked = coreSocketStatus(selected);
        // the real path the first passing check reached stays the selection: a link on the way that changes
        // later, even the owner's, never moves this server to another socket
        if (checked.status === "socket") { selected = checked.real; saidRefusal = null; }
        if (checked.status === "refused") { reason = "hc_socket_refused"; message = "The selected herdr-core socket is not a native socket on a path only this account or root controls.";
          // which entry fails, and why, once per change: the health message names no path
          if (checked.reason !== saidRefusal) console.error(`herdr-core socket refused: ${checked.reason}`);
          saidRefusal = checked.reason;
        }
        else if (checked.status === "socket" && await coreAnswers(checked.real)) {
          // every connection after this goes to the real path that passed (connection.ts walks it again):
          // no link is followed at connect time
          process.env["HC_SOCKET"] = checked.real;
          const identity = finishHerdrIdentity(checked.real);
          try {
            if (identity !== null) {
              const boot = herdrLifetime(identity);
              if (adapter === null) {
                adapterDir ??= mkdtempSync(join(tmpdir(), "ovis-fleet-hc-"));
                adapter = await startRuntime(adapterDir);
              } else if (health.boot_id !== boot) coreConnection().close();
              const hello = await coreConnection().hello();
              // Replacing the endpoint during hello cannot publish an identity for the old line.
              if (identity === finishHerdrIdentity(checked.real)) {
                health.boot_id = boot;
                runtimeVersion = `herdr-core-${versionText(hello.version)}`;
                reason = null; message = null;
              }
            }
          } catch (error) {
            if (error instanceof NoHerdrCoreError) { reason = "hc_not_found"; message = error.message; }
            else if (await coreAnswers(checked.real)) { reason = "hc_unsupported"; message = "The selected herdr-core did not answer the generation 1 framed protocol required by Ovis."; }
          }
        }
      }
      if (!stopped) {
        // Health and what is served never disagree: a core that is refused, gone or not yet checked serves
        // nothing (its open line is closed, the herdr API points at nothing) until a check passes again.
        if (reason !== null) {
          coreConnection().close();
          process.env["HERDR_SOCKET"] = unavailable;
        } else if (adapter !== null) process.env["HERDR_SOCKET"] = adapter.socketPath;
        health.socket_path = selected;
        health.runtime_down = reason !== null;
        health.reason = reason;
        health.message = message;
        health.terminal_mode = capabilities().attach === "hc" ? "attach" : "mirror";
      }
      return runtimeVersion;
    },
    stop() {
      stopped = true;
      coreConnection().close();
      adapter?.stop();
      if (adapterDir) rmSync(adapterDir, { recursive: true, force: true });
      serveRuntime(null);
    },
  };
}
