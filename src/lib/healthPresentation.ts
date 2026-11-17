export type HealthFreshness = "pending" | "fresh" | "unknown" | "unavailable";
export type HealthAnswer<T> = { ok: true; value: T } | { ok: false };

export interface MachineHealth<T> {
  readonly confirmed: T | null;
  readonly failures: number;
  readonly answered: number;
  readonly failed: readonly number[];
}

export type HealthBook<T> = ReadonlyMap<string, MachineHealth<T>>;

export const UNAVAILABLE_AFTER = 2;

const NOTHING_YET: MachineHealth<never> = { confirmed: null, failures: 0, answered: 0, failed: [] };

export function machineHealth<T>(book: HealthBook<T>, machineId: string): MachineHealth<T> {
  return book.get(machineId) ?? NOTHING_YET;
}

export function applyHealthRead<T>(book: HealthBook<T>, machineId: string, read: number, answer: HealthAnswer<T>): HealthBook<T> {
  const current = machineHealth(book, machineId);
  if (read <= current.answered) return book;
  const failed = answer.ok
    ? current.failed.filter((failure) => failure > read)
    : [...current.failed, read].sort((a, b) => a - b).slice(-UNAVAILABLE_AFTER);
  const next = new Map(book);
  next.set(machineId, answer.ok
    ? { confirmed: answer.value, failures: failed.length, answered: read, failed }
    : { confirmed: current.confirmed, failures: failed.length, answered: current.answered, failed });
  return next;
}

export function healthFreshness(health: Pick<MachineHealth<unknown>, "confirmed" | "failures">): HealthFreshness {
  if (health.failures === 0) return health.confirmed === null ? "pending" : "fresh";
  return health.failures < UNAVAILABLE_AFTER ? "unknown" : "unavailable";
}
