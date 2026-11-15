import { join } from "node:path";
import { omarchyTheme, type OmarchyTheme } from "../../shared/omarchy-theme.ts";
import { isJsonObject } from "../http.ts";
import { readStateDocument, writeStateDocument } from "../state-document.ts";

/** Devices kept: an address that never sends again is forgotten once this many newer ones did. */
const MAX_DEVICES = 64;

/**
 * The Omarchy theme of each device that sent one (PUT /api/machines/omarchy-theme), kept in
 * omarchy-themes.json so a restart keeps drawing a device in it. A device is the address it reaches
 * this server from, as the open route tells one (machine-api.ts `deviceOf`): the hook and the
 * browser on the same machine come from the same tailnet address.
 */
export class OmarchyThemeStore {
  private readonly themes = new Map<string, OmarchyTheme>();
  private readonly listeners = new Set<{ device: string; listener: (theme: OmarchyTheme | null) => void }>();
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, "omarchy-themes.json");
    try {
      const read = readStateDocument(this.path);
      const devices = read.kind === "json" && isJsonObject(read.value) && isJsonObject(read.value["devices"]) ? read.value["devices"] : {};
      for (const [device, stored] of Object.entries(devices)) {
        const theme = isJsonObject(stored) && isJsonObject(stored["colors"]) ? omarchyTheme({ ...stored["colors"], mode: stored["mode"] }, stored["name"]) : null;
        if (theme) this.themes.set(device, theme);
      }
    } catch (error) {
      console.error(`Cannot read ${this.path} (${(error as NodeJS.ErrnoException).code ?? "error"}); no device starts in its Omarchy theme`);
    }
  }

  get(device: string): OmarchyTheme | null { return this.themes.get(device) ?? null; }

  set(device: string, theme: OmarchyTheme): void {
    // the newest last, so the oldest leaves first
    this.themes.delete(device);
    this.themes.set(device, theme);
    for (const old of [...this.themes.keys()].slice(0, Math.max(0, this.themes.size - MAX_DEVICES))) this.themes.delete(old);
    writeStateDocument(this.path, `${JSON.stringify({ devices: Object.fromEntries(this.themes) }, null, 2)}\n`, false);
    for (const entry of [...this.listeners]) if (entry.device === device) entry.listener(theme);
  }

  subscribe(device: string, listener: (theme: OmarchyTheme | null) => void): () => void {
    const entry = { device, listener };
    this.listeners.add(entry);
    return () => { this.listeners.delete(entry); };
  }
}
