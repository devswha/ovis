import { CARD_TEXT_PREFIX, paneLifetimes } from "./paneLifetime.ts";

export interface CardText {
  machineId: string;
  paneId: string;
  session: string | null;
  promptId: string;
  text: string;
}

type CardStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const cardTexts = new Map<string, CardText>();

function parseCardText(raw: string | null): CardText | undefined {
  if (raw == null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const { machineId, paneId, session, promptId, text } = value as Partial<CardText>;
    if (typeof machineId !== "string" || typeof paneId !== "string" || (session !== null && session !== undefined && typeof session !== "string") || typeof promptId !== "string" || typeof text !== "string") return undefined;
    return { machineId, paneId, session: session ?? null, promptId, text };
  } catch {
    return undefined;
  }
}

export function getMemoryCardText(key: string): CardText | undefined {
  return cardTexts.get(key);
}

export function setCardText(key: string, typed: CardText | null, storage: () => CardStorage = () => paneLifetimes.paneStorage): void {
  if (typed === null) cardTexts.delete(key);
  else cardTexts.set(key, typed);
  try {
    if (typed === null) storage().removeItem(CARD_TEXT_PREFIX + key);
    else storage().setItem(CARD_TEXT_PREFIX + key, JSON.stringify(typed));
  } catch { /* storage refused: this page's memory keeps it */ }
}

export function heldCardTextFor(key: string, storage: () => CardStorage = () => paneLifetimes.paneStorage): CardText | undefined {
  const held = cardTexts.get(key);
  if (held !== undefined) return held;
  try {
    const typed = parseCardText(storage().getItem(CARD_TEXT_PREFIX + key));
    if (typed === undefined) return undefined;
    cardTexts.set(key, typed);
    return typed;
  } catch {
    return undefined;
  }
}

/**
 * Moves unsent prompt-card text when herdr moves a pane under a new ID: keep-on-conflict if the
 * destination already holds card text, and write-first so a failed destination write leaves the
 * source intact.
 */
export function moveCardText(before: string, after: string, toPaneId: string, storage: () => CardStorage = () => paneLifetimes.paneStorage): void {
  if (before === after) return;
  if (cardTexts.has(after)) return;
  let storedBefore: string | null = null;
  try {
    if (storage().getItem(CARD_TEXT_PREFIX + after) !== null) return;
    storedBefore = storage().getItem(CARD_TEXT_PREFIX + before);
  } catch {
    return;
  }
  if (storedBefore !== null) {
    const memBefore = cardTexts.get(before);
    const parsed = memBefore ?? parseCardText(storedBefore);
    const updated = parsed ? { ...parsed, paneId: toPaneId } : null;
    const serialized = updated ? JSON.stringify(updated) : storedBefore;
    try {
      storage().setItem(CARD_TEXT_PREFIX + after, serialized);
    } catch {
      return;
    }
    try {
      if (storage().getItem(CARD_TEXT_PREFIX + before) === storedBefore) {
        storage().removeItem(CARD_TEXT_PREFIX + before);
      }
    } catch {}
    if (memBefore) {
      cardTexts.delete(before);
      cardTexts.set(after, { ...memBefore, paneId: toPaneId });
    } else if (updated) {
      cardTexts.set(after, updated);
    }
    return;
  }
  const memBefore = cardTexts.get(before);
  if (!memBefore) return;
  const next = { ...memBefore, paneId: toPaneId };
  cardTexts.delete(before);
  cardTexts.set(after, next);
  try {
    storage().setItem(CARD_TEXT_PREFIX + after, JSON.stringify(next));
  } catch {}
}

paneLifetimes.onRetire((machineId) => {
  for (const [key, typed] of cardTexts) {
    if (typed.machineId !== machineId) continue;
    cardTexts.delete(key);
    if (typed.text.trim() !== "") paneLifetimes.keep(machineId, typed.paneId, "message", typed.text);
  }
});
