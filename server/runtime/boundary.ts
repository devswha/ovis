import type { HerdrMethod } from "../herdr/methods.ts";
import type { RuntimeCapabilities } from "./capabilities.ts";

/**
 * The boundary between this server and the runtime its terminals run on: the herdr-protocol
 * methods the server sends (each through a wrapper in server/herdr/client.ts, which names its
 * line) and what a runtime says of itself. A runtime behind the server (herdr, the herdr-core
 * adapter, the Ovis runtime's adapter) answers these and nothing else is asked of it;
 * boundary.contract.test.ts checks the answers every runtime must give.
 */

/** What the server reads: the methods boundary.contract.test.ts drives on every runtime. */
export type BoundaryReadMethod =
  | "ping"
  | "session.snapshot"
  | "pane.get"
  | "agent.get"
  | "pane.process_info"
  | "pane.read"
  | "events.subscribe";

/** Every other herdr method server/herdr/client.ts sends. */
export type BoundaryWriteMethod =
  | "server.agent_manifests"
  | "plugin.list"
  | "plugin.action.list"
  | "plugin.action.invoke"
  | "plugin.log.list"
  | "integration.list"
  | "workspace.create"
  | "workspace.rename"
  | "workspace.move"
  | "workspace.close"
  | "tab.create"
  | "tab.rename"
  | "tab.move"
  | "tab.close"
  | "agent.start"
  | "agent.rename"
  | "agent.prompt"
  | "pane.rename"
  | "pane.move"
  | "pane.scroll"
  | "pane.copy_motion"
  | "pane.copy_search"
  | "pane.selection.read"
  | "pane.send_text"
  | "pane.send_keys"
  | "pane.close"
  | "pane.focus"
  | "pane.split"
  | "pane.zoom"
  | "pane.swap"
  | "pane.resize"
  | "pane.clear"
  | "layout.set_split_ratio"
  | "worktree.create"
  | "worktree.list"
  | "worktree.open"
  | "worktree.remove";

/** The herdr-protocol subset the server uses: a runtime that answers these serves everything the server asks. */
export type BoundaryMethod = BoundaryReadMethod | BoundaryWriteMethod;

/**
 * What a second request on one connection gets. `per-request`: herdr's own model, which its
 * herdr-protocol adapters keep: one request per connection, then the runtime closes it.
 * `persistent`: the request is answered on the same connection.
 */
export type ConnectionModel = "per-request" | "persistent";

/** The keys of the capability record a runtime is served under (capabilities.ts). */
export type BoundaryCapabilityKey = keyof RuntimeCapabilities;

/** The keys a ping's `capabilities` may carry, which `ping()` and `runtimeIdentity()` read. */
export type PingCapabilityKey = "direct_terminal_attach" | "runtime" | "layout";

/**
 * One wrong answer boundary.contract.test.ts gives on purpose (`BOUNDARY_FAULT`), so each case
 * family is shown to fail on its fault: `wrong-pane`, a misnamed target answered for another pane;
 * `second-request-dropped`, a connection held open after its first answer with nothing more said;
 * `missed-not-sent`, a subscriber that fell behind left open; `recent-without-history`, a recent
 * read without the lines above the screen.
 */
export type BoundaryFault = "wrong-pane" | "second-request-dropped" | "missed-not-sent" | "recent-without-history";

/** Every method client.ts types for herdrRpc (methods.ts) is one the boundary lists. */
const _typedMethodsAreBoundary: HerdrMethod extends BoundaryMethod ? true : never = true;
void _typedMethodsAreBoundary;
