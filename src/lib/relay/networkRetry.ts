/**
 * A request to the account service that an enrollment makes (accountController.ts), sent again when it got no answer
 * at all (account/service.ts AccountServiceUnreachableError: the connection dropped under it) or the service said it
 * is busy (429), within ACCOUNT_SENDS sends: a network that stays down ends it as it always did.
 */
import { AccountServiceError, AccountServiceUnreachableError } from "../account/service.ts";

/** Sends of one request in all, the first included. */
export const ACCOUNT_SENDS = 3;
/** The wait before the second, then the third send. A request that got no answer goes sooner once the browser is online again. */
export const NETWORK_RETRY_MS = [2_000, 8_000] as const;
/** The longest `retry-after` a busy answer (429) is waited out for: one that asks for longer ends the request as refused. */
export const RETRY_AFTER_MAX_MS = 60_000;

/**
 * `send`, sent again as above. A busy answer waits at least the `retry-after` it named; one that got no answer waits
 * until the browser is online again or its backoff is over. Either waits further while the page is hidden, so a tab
 * left in the background sends nothing. `before` runs after each wait and before the next send, and ends it by
 * throwing: the enrollment checks there that it still owns its pairing. `signal` ends a wait, throwing its reason.
 */
export async function sendAgainWhenBack<T>(send: () => Promise<T>, options: { readonly before: () => Promise<void>; readonly signal?: AbortSignal | undefined }): Promise<T> {
  for (let sent = 1; ; sent++) {
    try { return await send(); } catch (error) {
      const backoff = NETWORK_RETRY_MS[Math.min(sent, NETWORK_RETRY_MS.length) - 1] ?? NETWORK_RETRY_MS[0];
      const busy = error instanceof AccountServiceError && error.status === 429 ? Math.max(error.retryAfterMs ?? 0, backoff) : null;
      if (sent >= ACCOUNT_SENDS || !(error instanceof AccountServiceUnreachableError || (busy !== null && busy <= RETRY_AFTER_MAX_MS))) throw error;
      console.warn("Ovis: a request to the account service failed while this PC joined the account; sending it again", error instanceof Error ? error.name : error);
      await pause(busy ?? backoff, busy === null, options.signal);
      await options.before();
    }
  }
}

/** `ms`, then until the page is shown; `online`: the browser's online event ends it sooner. */
function pause(ms: number, online: boolean, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const end = (): void => {
      clearTimeout(timer);
      window.removeEventListener("online", end);
      document.removeEventListener("visibilitychange", shown);
      signal?.removeEventListener("abort", aborted);
    };
    const go = (): void => { end(); resolve(); };
    const aborted = (): void => { end(); reject(signal?.reason); };
    const shown = (): void => { if (document.visibilityState !== "hidden") go(); };
    if (online) window.addEventListener("online", go);
    signal?.addEventListener("abort", aborted, { once: true });
    // fixed wait: a backoff between sends (or the service's own retry-after), not a wait for a state
    const timer = setTimeout(() => {
      if (document.visibilityState !== "hidden") { go(); return; }
      document.addEventListener("visibilitychange", shown);
    }, ms);
  });
}
