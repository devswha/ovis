import { join } from "node:path";
import type { UsageReport } from "../shared/protocol.ts";
import { badRequest, isJsonObject, jsonResponse } from "./http.ts";
import { readStateDocument, writeStateDocument } from "./state-document.ts";
import type { UsageService } from "./usage.ts";

class RemovedAccountsUnreadable extends Error {
  constructor(readonly path: string) {
    super("The removed accounts list cannot be read");
  }
}

/**
 * Accounts removed from Ovis, not signed out of their CLIs. Only public account keys are saved;
 * no credential home, keychain item or token is changed. A successful explicit sign-in restores
 * its account. Token refreshes and server restarts do not.
 */
export class UsageAccountList {
  private readonly path: string;

  constructor(stateDir: string, private readonly usage: UsageService) {
    this.path = join(stateDir, "usage-removed.json");
  }

  private read(): string[] {
    const document = readStateDocument(this.path);
    if (document.kind === "missing") return [];
    if (document.kind === "json" && isJsonObject(document.value)) {
      const keys = document.value["accounts"];
      if (Array.isArray(keys) && keys.every((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 256)) return keys;
    }
    throw new RemovedAccountsUnreadable(this.path);
  }

  restore(key: string): void {
    const held = this.read();
    if (held.includes(key)) writeStateDocument(this.path, JSON.stringify({ accounts: held.filter((account) => account !== key) }), false);
  }

  async report(refresh = false): Promise<UsageReport> {
    const removed = new Set(this.read());
    const report = await this.usage.report(refresh);
    return { ...report, providers: report.providers.filter((account) => !removed.has(account.key)) };
  }

  async remove(request: Request): Promise<Response> {
    if (request.method !== "DELETE") return jsonResponse({ error: { code: "method_not_allowed", message: "Use DELETE /api/usage/accounts" } }, 405, { allow: "DELETE" });
    const body: unknown = await request.json().catch(() => null);
    if (!isJsonObject(body) || Object.keys(body).length !== 1 || typeof body["account"] !== "string" || body["account"].length > 256) {
      return badRequest("invalid_account", "Name one listed account");
    }
    const key = body["account"];
    const report = await this.usage.report();
    if (!report.providers.some((account) => account.key === key)) return jsonResponse({ error: { code: "account_not_found", message: "This PC no longer lists that account" } }, 404);
    const held = this.read();
    if (!held.includes(key)) writeStateDocument(this.path, JSON.stringify({ accounts: [...held, key] }), false);
    return new Response(null, { status: 204 });
  }
}
