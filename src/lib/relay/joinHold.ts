/**
 * The new device's wait and the older device's "It's me" (device table P17, T53, T57). The wait is the
 * PC's own deadline; "It's me" only ends it early where that PC's own checks pass, so it is sent to each
 * PC reached and kept for the ones that have not answered, apart from the acknowledgment of what was seen.
 */
import type { DeviceNotice, HoldState, NoticeAnswer } from "../../../shared/account-devices-api.ts";

/** Milliseconds left of the join hold; null for a hold with no deadline (catching up, frozen, or a join hold not yet published). */
export function holdWaitMs(hold: HoldState | undefined, now: number): number | null {
  if (hold === undefined) return 0;
  if (hold.reason !== "join_hold" || hold.until === null) return null;
  return Math.max(0, Date.parse(hold.until) - now);
}

export function itsMeAnswer(notice: DeviceNotice): NoticeAnswer {
  return { type: "notice-answer", id: notice.id, answer: "its_me" };
}

/** Notice id to the PCs an "It's me" for it still waits on. */
export type ItsMeWaiting = ReadonlyMap<string, ReadonlySet<string>>;

export function withItsMeSent(waiting: ItsMeWaiting, id: string, serverIds: readonly string[]): ItsMeWaiting {
  return new Map(waiting).set(id, new Set([...(waiting.get(id) ?? []), ...serverIds]));
}

export function withItsMeAnswered(waiting: ItsMeWaiting, id: string, serverId: string): ItsMeWaiting {
  const left = new Set(waiting.get(id));
  left.delete(serverId);
  const next = new Map(waiting);
  if (left.size === 0) next.delete(id); else next.set(id, left);
  return next;
}
