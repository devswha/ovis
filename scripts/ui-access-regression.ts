// Sign out on a server with a token, and the relay panel: a part of scripts/ui-regression.ts, run on its own so each
// part fits the browser lane's limit for one script.
process.env["UI_REGRESSION_PART"] = "access";
// set before the script loads, so the import is dynamic
await import("./ui-regression.ts");
export {};
