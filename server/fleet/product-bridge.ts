/** A fleet bridge beside an existing product engine. It never owns the engine's lifetime. */
import { mkdirSync } from "node:fs";
import { version } from "../../package.json";
import { AgentDetector, catalogLocator, defaultLoginProbe } from "../agent-catalog-detect.ts";
import { finishHerdrIdentity } from "../finishes.ts";
import { setRuntime } from "../herdr-core/runtime.ts";
import { savedServerId } from "../relay/identity.ts";
import { ShellAgentLocator } from "../shell-agent.ts";
import { defaultStateDir } from "../update-state.ts";
import { claimMachineBridge, fleetMachinePaths, machineDescriptorPath, openMachineBridge, RECHECK_MS, versionText, writeAdvert, type BridgeAdvert } from "./machine-bridge-common.ts";
import { productEngine } from "./product-engine.ts";
import { runtimeIdentity } from "./runtime-identity.ts";

export async function startProductBridge(options: {
  /** Tests advance the recheck clock explicitly; production checks every RECHECK_MS. Returns the cancellation. */
  recheck?: (tick: () => Promise<void>) => () => void;
  /** Observes a completed engine check, after the advert is current. No input or engine start is coupled to it. */
  onRecheck?: () => void;
} = {}) {
  if (process.platform === "win32") throw new Error("Fleet machines require Linux or macOS");
  const isCore = process.env["OVIS_RUNTIME"] === "herdr-core";
  setRuntime(isCore ? "herdr-core" : "herdr", "existing-only");
  const { stateDir, fleetState } = fleetMachinePaths();
  const descriptor = machineDescriptorPath(fleetState);
  const release = claimMachineBridge(descriptor);
  let bridge: ReturnType<typeof openMachineBridge> | undefined;
  let engine: ReturnType<typeof productEngine> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let pending: Promise<void> | undefined;
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const identity = runtimeIdentity(fleetState);
    const id = identity.runtime_id;
    const selected = productEngine(stateDir, id, isCore);
    engine = selected;
    const { health, unavailable } = selected;
    let runtimeVersion = isCore ? "herdr-core-unknown" : "herdr-unknown";
    let loggedOwnIdentity = false;
    const probe = async () => {
      // This lookup is diagnostic only: runtime-id.json remains the sole source of the PC id.
      if (identity.source.kind === "minted" && !loggedOwnIdentity) {
        const ownId = savedServerId(defaultStateDir());
        if (ownId) {
          console.info(`Own Ovis identity ${ownId} is now available; keeping recorded fleet runtime_id ${id}.`);
          loggedOwnIdentity = true;
        }
      }
      runtimeVersion = await selected.probe();
    };
    await probe();
    bridge = openMachineBridge({
      stateDir, descriptor, pcServerId: id,
      shellAgents: new ShellAgentLocator(), agentDetector: new AgentDetector({ locate: catalogLocator({ probe: defaultLoginProbe() }) }),
      fleetBridgeHealth: () => ({ ...health }),
      herdrIdentity: () => health.socket_path === null ? null : finishHerdrIdentity(health.socket_path),
    });
    const listener = bridge;
    selected.watchStatus(listener.server.statusReady, () => listener.server.context.services.core.collector.refresh());
    listener.selectedSocket(health.socket_path ?? unavailable);
    const advert = (): BridgeAdvert => ({
      v: 1, runtime_id: id, machine_id: id, boot_id: health.boot_id, bridge_port: listener.port, bridge_token: listener.token,
      runtime_down: health.runtime_down, versions: { server: versionText(version), agent: "none", runtime: versionText(runtimeVersion) },
    });
    let current = advert();
    const advertPath = writeAdvert(fleetState, current);
    const tick = () => pending = (async () => {
      const before = health.socket_path;
      await probe();
      if (stopped) return;
      if (before !== health.socket_path) listener.selectedSocket(health.socket_path ?? unavailable);
      const next = advert();
      if (JSON.stringify(next) !== JSON.stringify(current)) { writeAdvert(fleetState, next); current = next; }
      options.onRecheck?.();
    })();
    const schedule = () => {
      timer = setTimeout(() => {
        void tick().catch((error: unknown) => { console.error("Fleet bridge health could not be refreshed:", error); })
          .finally(() => { if (!stopped) schedule(); });
      }, RECHECK_MS);
    };
    const cancel = options.recheck?.(tick) ?? (() => { schedule(); return () => clearTimeout(timer); })();
    listener.server.warmAgentCatalog();
    return {
      port: listener.port, token: listener.token, advertPath, advert: () => current, statusReady: listener.server.statusReady,
      async stop() {
        if (stopped) return;
        stopped = true;
        cancel();
        await pending;
        listener.close();
        selected.stop();
        release();
      },
    };
  } catch (error) {
    stopped = true;
    clearTimeout(timer);
    bridge?.close();
    engine?.stop();
    release();
    throw error;
  }
}
