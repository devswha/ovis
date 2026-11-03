import { LINE_BYTES, makeLineReader } from "../herdr/client.ts";
import type { PreferencesChange, SharedPreferences } from "../../shared/preferences.ts";
import type { HcConnection } from "./connection.ts";
import { isRecord } from "./snapshot.ts";

/**
 * Pinned agents, shared by every Herdr client (herdr-app docs/labels.md): present and non-empty,
 * the terminal is pinned; written empty, it is not.
 */
export const PINNED_LABEL = "herdr.pinned";
/** How long a line to hc that ended waits before the bridge looks again. */
const REOPEN_MS = 1_000;

type Hc = Pick<HcConnection, "call" | "open">;
interface PinStore {
  get(): SharedPreferences;
  set(change: PreferencesChange): SharedPreferences;
  subscribe(listener: (preferences: SharedPreferences) => void): () => void;
}

/**
 * Keeps the Agents list's pins (the shared preferences' `pins`, `<pc>:<pane>` for an agent) and
 * herdr-core's `herdr.pinned` labels the same for this PC's terminals: a pin made in a browser is
 * written on its terminal, and one made or removed in the Herdr app joins or leaves the list (at
 * its end, as a pin made here does). The first time a terminal is seen, a pin on either side
 * counts, so neither side's pins are lost when the two first meet. Workspace pins have no label
 * and stay Ovis's own.
 */
export function bridgePins(hc: Hc, store: PinStore, machineId: string): () => void {
  /** each live terminal's pin as its label last said, or as it was last written */
  const labeled = new Map<string, boolean>();
  const keyOf = (address: string) => `${machineId}:${address}`;
  const pins = () => store.get().pins ?? [];
  let stopped = false;
  let closeStream: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const change = (next: string[]) => {
    try { store.set({ settings: {}, pins: next }); }
    catch (error) { console.warn("herdr-core: could not keep a pin from the Herdr app:", error); }
  };
  const label = (address: string, pinned: boolean) => {
    labeled.set(address, pinned);
    hc.call("terminal.label", { terminal: address, labels: { [PINNED_LABEL]: pinned ? "1" : "" } })
      .catch((error: unknown) => console.warn(`herdr-core: could not ${pinned ? "pin" : "unpin"} ${address} for the Herdr app:`, error));
  };
  const onLabel = (address: string, pinned: boolean) => {
    const before = labeled.get(address);
    labeled.set(address, pinned);
    const key = keyOf(address);
    const list = pins();
    const listed = list.includes(key);
    if (pinned && !listed) change([...list, key]);
    else if (!pinned && listed) {
      if (before === undefined) label(address, true);
      else if (before) change(list.filter((pin) => pin !== key));
    }
  };
  const pinnedIn = (labels: unknown) => isRecord(labels) && typeof labels[PINNED_LABEL] === "string" && labels[PINNED_LABEL] !== "";
  const remember = (record: unknown) => {
    if (!isRecord(record) || typeof record["address"] !== "string" || record["state"] !== "live") return;
    onLabel(record["address"], pinnedIn(record["labels"]));
  };

  const unsubscribe = store.subscribe((preferences) => {
    // no browser has shared its pins yet: that is no unpin
    if (preferences.pins === undefined) return;
    const list = new Set(preferences.pins);
    for (const [address, pinned] of labeled) if (list.has(keyOf(address)) !== pinned) label(address, !pinned);
  });

  const reopen = () => {
    closeStream = null;
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; void open(); }, REOPEN_MS);
  };
  const lines = makeLineReader(LINE_BYTES, (line) => {
    let message: unknown;
    try { message = JSON.parse(line); } catch { return; }
    if (!isRecord(message)) return;
    // fell behind: the stream ends, and the next one's snapshot says what was missed
    if (message["method"] === "missed") { closeStream?.(); return; }
    const params = message["params"];
    if (message["method"] !== "event" || !isRecord(params) || typeof params["terminal"] !== "string") return;
    const data = isRecord(params["data"]) ? params["data"] : {};
    switch (params["type"]) {
      case "created": remember(data); return;
      case "labels": if (labeled.has(params["terminal"])) onLabel(params["terminal"], pinnedIn(data["labels"])); return;
      case "finished":
      case "removed": labeled.delete(params["terminal"]); return;
      default: return;
    }
  }, () => closeStream?.());
  const open = async () => {
    try {
      const { result, channel } = await hc.open("events.subscribe", {}, { onData: lines, onClose: reopen });
      if (stopped) { void channel.close(); return; }
      closeStream = () => { void channel.close(); };
      for (const record of result.terminals ?? []) remember(record);
    } catch (error) {
      console.warn("herdr-core: pins are not shared with the Herdr app until its events can be read:", error);
      reopen();
    }
  };
  void open();

  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
    closeStream?.();
  };
}
