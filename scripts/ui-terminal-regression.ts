// The terminal's keys, input line, held drafts and attach of scripts/ui-regression.ts: a part of it, run on its own so
// each part fits the browser lane's limit for one script.
process.env["UI_REGRESSION_PART"] = "terminal";
// set before the script loads, so the import is dynamic
await import("./ui-regression.ts");
export {};
