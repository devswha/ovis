/** Execution failed; unlike identity rejection, this must not clear the current chat. */
export class GjcSdkLookupError extends Error {
  constructor(readonly reason: "timeout" | "unavailable") {
    super("GJC SDK lookup failed");
    this.name = "GjcSdkLookupError";
  }
}

export function lookupExecutionError(error: unknown): GjcSdkLookupError {
  if (error instanceof GjcSdkLookupError) return error;
  const detail = typeof error === "object" && error !== null ? error : {};
  const timedOut = Reflect.get(detail, "killed") === true || Reflect.get(detail, "signal") === "SIGKILL"
    || Reflect.get(detail, "code") === "ETIMEDOUT" || Reflect.get(detail, "code") === "ERR_CHILD_PROCESS_TIMEOUT"
    || Reflect.get(detail, "code") === "timeout";
  return new GjcSdkLookupError(timedOut ? "timeout" : "unavailable");
}
