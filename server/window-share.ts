/** A browser-selected window, exposed to a pane's agent as one changing image file. */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { imageType } from "./codex-images.ts";
import { paneGet } from "./herdr/client.ts";
import { preparePasteDirectory } from "./paste.ts";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_ENCODED_BYTES = Math.ceil(MAX_FRAME_BYTES / 3) * 4 + 4;
const LEASE_MS = 30_000;
const MAX_SHARES_PER_PANE = 4;
const MAX_SHARES_TOTAL = 32;

export class WindowShareError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

interface Share { paneId: string; path: string; updatedAt: number }

/** One store per bridge. A lost browser's files expire; stopping the bridge removes them all. */
export class WindowShares {
  private readonly shares = new Map<string, Share>();
  private readonly paths = new Set<string>();
  private readonly registry: string;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(stateDir: string, private readonly now = () => Date.now()) {
    this.registry = join(stateDir, "window-shares.json");
    // A process crash cannot run close(). Reap only our generated names from the previous run.
    try {
      const stale: unknown = JSON.parse(readFileSync(this.registry, "utf8"));
      if (Array.isArray(stale)) for (const path of stale) {
        if (typeof path !== "string" || !/^window-share-[0-9a-f-]{36}\.jpg$/.test(basename(path))) continue;
        try { unlinkSync(path); } catch { /* already gone */ }
      }
      unlinkSync(this.registry);
    } catch { /* first start, or an unreadable registry */ }
    this.timer = setInterval(() => this.prune(), 10_000);
    this.timer.unref?.();
  }

  private saveRegistry(): void {
    const temporary = `${this.registry}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify([...this.paths]), { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.registry);
    } finally {
      try { unlinkSync(temporary); } catch { /* rename already consumed it */ }
    }
  }

  private frame(dataBase64: string): Buffer {
    if (dataBase64.length > MAX_ENCODED_BYTES) throw new WindowShareError("frame_too_large", "window frame is too large", 413);
    const data = Buffer.from(dataBase64, "base64");
    if (data.length > MAX_FRAME_BYTES) throw new WindowShareError("frame_too_large", "window frame is too large", 413);
    if (imageType(data) !== "image/jpeg") throw new WindowShareError("invalid_frame", "window frame must be JPEG", 400);
    return data;
  }

  private write(path: string, data: Buffer): void {
    // A reader sees the last complete frame until rename; a replaced link is never followed.
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      try { unlinkSync(temporary); } catch { /* rename already consumed it */ }
    }
  }

  async start(paneId: string, dataBase64: string): Promise<{ id: string; path: string }> {
    const frame = this.frame(dataBase64);
    this.prune();
    const pane = await paneGet(paneId);
    if (this.shares.size >= MAX_SHARES_TOTAL || [...this.shares.values()].filter((share) => share.paneId === paneId).length >= MAX_SHARES_PER_PANE) {
      throw new WindowShareError("too_many_shares", "too many windows are shared", 409);
    }
    const id = crypto.randomUUID();
    const path = join(preparePasteDirectory(pane.cwd), `window-share-${id}.jpg`);
    this.paths.add(path);
    try {
      this.saveRegistry();
      this.write(path, frame);
    } catch (error) {
      this.paths.delete(path);
      this.saveRegistry();
      throw error;
    }
    this.shares.set(id, { paneId, path, updatedAt: this.now() });
    return { id, path };
  }

  update(paneId: string, id: string, dataBase64: string): void {
    const frame = this.frame(dataBase64);
    this.prune();
    const share = this.shares.get(id);
    if (!share || share.paneId !== paneId) throw new WindowShareError("share_not_found", "window share has ended", 404);
    this.write(share.path, frame);
    share.updatedAt = this.now();
  }

  stop(paneId: string, id: string): void {
    const share = this.shares.get(id);
    if (!share || share.paneId !== paneId) return;
    this.shares.delete(id);
    try { unlinkSync(share.path); } catch { /* already removed */ }
    this.paths.delete(share.path);
    this.saveRegistry();
  }

  private prune(): void {
    for (const [id, share] of this.shares) if (this.now() - share.updatedAt > LEASE_MS) this.stop(share.paneId, id);
  }

  close(): void {
    clearInterval(this.timer);
    for (const [id, share] of this.shares) this.stop(share.paneId, id);
  }
}
