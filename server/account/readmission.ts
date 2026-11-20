import type { AccountRow } from "./account-device-state.ts";

export type Readmission = (read: () => Promise<void>) => Promise<void>;

/** Proof authorizes only the read being awaited, for this account and this expired admission. */
export class AccountReadmissions {
  private readonly attempts = new Set<{ readonly row: AccountRow; readonly account: string }>();

  retry(row: AccountRow | null, account: string | null): Readmission | undefined {
    if (row === null || account === null || row.state !== "expired") return undefined;
    return async read => {
      const attempt = { row, account };
      this.attempts.add(attempt);
      try { await read(); }
      finally { this.attempts.delete(attempt); }
    };
  }

  permits(row: AccountRow, account: string): boolean {
    return [...this.attempts].some(attempt => attempt.account === account
      && attempt.row.id === row.id && attempt.row.key === row.key && attempt.row.origin.admit_no === row.origin.admit_no);
  }
}
