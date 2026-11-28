import { isWssOrigin } from "../../../shared/relay-offer.ts";

export { offerFromCode, TypedCodeError, type TypedCodeFailure, type TypedCodeOptions } from "../../../shared/relay-code-offer.ts";

/**
 * The relay this copy of the hosted shell looks typed codes up on, from `<meta name="ovis-relay">`
 * (scripts/shell-build.ts): a wss origin, else undefined and Ovis's global relay.
 */
export function shellRelayOf(document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }): string | undefined {
  const content = document.querySelector('meta[name="ovis-relay"]')?.getAttribute("content");
  return content && isWssOrigin(content) ? content : undefined;
}
