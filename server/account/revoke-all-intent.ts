import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { StoredDevice } from "../devices.ts";
import { writePrivateState } from "../private-state.ts";

/** Once the intent is durable, detached ordinary rows still belong to it until the registry is saved. */
export class RevokeAllIntent {
  private readonly path: string;
  private targets: readonly StoredDevice[] | null;
  private problem: string | null = null;
  /** How many account-joined rows the Revoke all covered when it began; an intent that will not read covers some. */
  private listedRows = 0;

  get strict(): string | null { return this.problem; }

  constructor(dir: string, rows: readonly StoredDevice[]) {
    this.path = join(dir, "revoke-all.json");
    this.targets = existsSync(this.path) ? rows : null;
    if (this.targets !== null) this.listedRows = listedIn(this.path);
  }

  get listed(): number { return this.listedRows; }

  begin(rows: readonly StoredDevice[], at: string, listed: number): void {
    writePrivateState(this.path, { id: randomBytes(16).toString("hex"), by: "pc", at, rows, listed });
    this.targets = rows;
    this.listedRows = listed;
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

/** An intent written before `listed` existed names none; one that will not read names some, so it stays. */
function listedIn(path: string): number {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null && "listed" in value && typeof value.listed === "number" ? value.listed : 0;
  } catch { return 1; }
}
