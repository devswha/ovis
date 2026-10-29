import { lazyChunk } from "./lazyChunk.ts";

/** Hosted-shell callers load cryptography and mux code only when connecting to a PC. */
export const loadRelayChannel = lazyChunk(() => import("./relay/channel.ts"));
