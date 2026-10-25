/**
 * Keys the app's history modules write into history entries' state, shared so one can tell the
 * other's entries without importing it (sheetHistory patches the history when it loads).
 */

/** a phone sheet's own entry (lib/sheetHistory.ts): a push made while it is current replaces it */
export const SHEET_HISTORY_KEY = "ovis:sheet";
