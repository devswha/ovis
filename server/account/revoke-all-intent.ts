import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { StoredDevice } from "../devices.ts";
import { writePrivateState } from "../private-state.ts";

/** Once the intent is durable, detached ordinary rows still belong to it until the registry is saved. */
export class RevokeAllIntent {
  private readonly path: string;
  private targets: readonly StoredDevice[] | null;
  private problem: string | null = null;

  get strict(): string | null { return this.problem; }

  constructor(dir: string, rows: readonly StoredDevice[]) {
    this.path = join(dir, "revoke-all.json");
    this.targets = existsSync(this.path) ? rows : null;
  }

  begin(rows: readonly StoredDevice[], at: string): void {
    writePrivateState(this.path, { id: randomBytes(16).toString("hex"), by: "pc", at, rows });
    this.targets = rows;
  }

  finish(write: (rows: readonly StoredDevice[]) => void): void {
    if (this.targets === null) return;
    try {
      write(this.targets);
      rmSync(this.path);
      this.targets = null;
      this.problem = null;
    } catch (error) {
      this.problem = `Revoke all could not be finished (${error instanceof Error ? error.message : String(error)}): only this PC itself gets in until it is.`;
      throw error;
    }
  }
}
