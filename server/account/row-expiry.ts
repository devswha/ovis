import type { AccountRow } from "./account-device-state.ts";

export const EXPIRY_DAYS = 60;

/** UTC midnight on the sixtieth unused day, including admissions never used here. */
export function unusedUntil(day: string): number {
  return Date.parse(day) + EXPIRY_DAYS * 86_400_000;
}

export function expiresAt(row: AccountRow): number {
  return row.state === "expired" ? Infinity : unusedUntil(row.last_signin_day ?? row.origin.at.slice(0, 10));
}
