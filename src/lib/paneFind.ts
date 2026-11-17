import type { PaneFindResponse } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";

export function findResultAfterError(result: PaneFindResponse | null, cause: unknown): PaneFindResponse | null {
  return cause instanceof ApiError && cause.code === "stale_content" ? null : result;
}
