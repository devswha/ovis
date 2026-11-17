import type { InteractivePrompt, PromptAnswer } from "../../shared/protocol.ts";
import { CASE_FOLDING_DATA } from "./caseFolding.generated.ts";
import { CONFUSABLES_DATA } from "./confusables.generated.ts";
import { t } from "./i18n.ts";
import { optionName, promptWords } from "./promptText.ts";

/** The agents whose own keys move between a form's questions (pi's tabs, Claude Code's question tabs, omo's Tab, omp's Tab, Codex's ←/→, Hermes's Tab, agy's ←/→): a move carries none of the card's edits. */
const KEYED_STEPS = new Set(["pi", "claude", "omo", "omp", "codex", "hermes", "agy"]);

export type TypedAnswer = Pick<PromptAnswer, "option_index" | "option_indices" | "custom_text">;

function choices(prompt: InteractivePrompt): number[] {
  return prompt.options.flatMap((_, index) => index === prompt.custom_option_index ? [] : [index]);
}

function boundLetter(label: string): string | null {
  return label.match(/\(([a-z])\)$/i)?.[1]?.toLowerCase() ?? null;
}

/**
 * text as a page shows it, for comparing what is typed with what a card shows (never what is sent): one
 * Unicode form by look (NFKC: `e` and a combining accent is `é`, the ligature `ﬁ` is `fi`), without
 * the marks a page does not draw (format characters and every default-ignorable code point: zero-width
 * space and joiners, word joiner, soft hyphen, byte order mark, the combining grapheme joiner, variation
 * selectors, Hangul fillers; a visible accent stays), its spacing collapsed.
 */
const spaced = (text: string): string => text.normalize("NFKC").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

const caseFolds = new Map(CASE_FOLDING_DATA.split(";").map((entry) => {
  const [from, to] = entry.split("=") as [string, string];
  return [String.fromCodePoint(parseInt(from, 16)), String.fromCodePoint(...to.split(" ").map((hex) => parseInt(hex, 16)))];
}));
/** Unicode's full case folding (CaseFolding.txt C and F): `Straße`, `STRASSE` and `STRAẞE` all fold to `strasse` */
const toCasefold = (text: string): string => Array.from(text, (char) => caseFolds.get(char) ?? char).join("");

const confusables = new Map(CONFUSABLES_DATA.split(";").map((entry) => {
  const [from, to] = entry.split("=") as [string, string];
  return [String.fromCodePoint(parseInt(from, 16)), String.fromCodePoint(parseInt(to, 16))];
}));
/** Each letter Unicode draws like an ASCII letter or digit (confusables.txt, UTS #39) as that one: Cyrillic `о` and Greek `ο` as `o`, `1` as `l` */
const unconfused = (text: string): string => Array.from(text, (char) => confusables.get(char) ?? char).join("");

/**
 * What a name reads as, for telling rows apart (#2220): Unicode's compatibility caseless form (Unicode 3.13,
 * D146: NFKD(toCasefold(NFKD(toCasefold(NFD(x)))))), then its letters, marks and digits alone.
 */
export const skeleton = (text: string): string => toCasefold(unconfused(toCasefold(toCasefold(text.normalize("NFD")).normalize("NFKD")).normalize("NFKD"))).normalize("NFKD")
  .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").replace(/[^\p{L}\p{M}\p{N}]/gu, "").normalize("NFD");

function bareLabel(label: string): string {
  return spaced(label.replace(/^\(recommended\)\s+|\s*\((?:[a-z]|esc|recommended)\)$/i, ""));
}

export function answerFromText(prompt: InteractivePrompt, text: string): TypedAnswer | null {
  const value = text.trim();
  if (!value) return null;
  const valid = choices(prompt);
  const byNumber = (token: string): number | null => {
    if (!/^\d+$/.test(token)) return null;
    const index = Number(token) - 1;
    return valid.includes(index) ? index : null;
  };
  const typed = (): TypedAnswer | null => prompt.custom_option_index !== null ? { custom_text: value } : null;
  const words = promptWords(prompt);
  const nameOf = (said: string, literal = false): number | null | undefined => {
    const lower = spaced(said);
    const names = (label: string): boolean => spaced(label) === lower || bareLabel(label) === lower || boundLetter(label) === lower;
    const only = (label: (index: number) => string, named = names): number | null | undefined => {
      const found = valid.filter((index) => named(label(index)));
      if (found.length > 1) return null;
      const alike = (shape: string): number => valid.filter((index) => skeleton(label(index)) === shape).length;
      if (found.length === 1) return alike(skeleton(label(found[0]!))) > 1 ? null : found[0];
      return !literal && alike(skeleton(said)) > 1 ? null : undefined;
    };
    if (prompt.text_format === "markdown") return only((index) => optionName(prompt, prompt.options[index]!.label).words, (shown) => spaced(shown) === lower);
    const own = only((index) => prompt.options[index]!.label);
    return own !== undefined ? own : only((index) => words.label(index));
  };
  const whole = nameOf(value, /^[\d\s,]+$/.test(value));
  if (whole === null) return typed();
  if (whole !== undefined) return prompt.multi_select ? { option_indices: [whole] } : { option_index: whole };
  const tokens = prompt.multi_select ? value.split(/[\s,]+/).filter(Boolean) : [value];
  const indices = tokens.map(byNumber);
  const own = (token: string, index: number | null): boolean => {
    const named = nameOf(token, true);
    return index !== null && (named === undefined || named === index);
  };
  if (tokens.length === 0 || !tokens.every((token, at) => own(token, indices[at]!))) return typed();
  return prompt.multi_select ? { option_indices: [...new Set(indices as number[])] } : { option_index: indices[0]! };
}

function range(prompt: InteractivePrompt): string {
  const numbers = choices(prompt).map((index) => index + 1);
  return numbers.length > 1 ? `${numbers[0]}–${numbers.at(-1)}` : String(numbers[0] ?? 1);
}

export function sendsChecksWithText(prompt: InteractivePrompt): boolean {
  return prompt.multi_select && !prompt.fallback && (prompt.checks_with_text === true || prompt.agent === "opencode");
}

export function blocksStepNavigation(prompt: InteractivePrompt, selected: ReadonlySet<number>, custom: string): boolean {
  if (!KEYED_STEPS.has(prompt.agent) || prompt.drafts_saved || !(prompt.can_step_next || prompt.can_step_back || prompt.steps?.some(step => step.can_navigate))) return false;
  return custom !== (prompt.default_custom_text ?? "") || prompt.multi_select
    && JSON.stringify([...selected].sort((a, b) => a - b)) !== JSON.stringify(prompt.default_option_indices ?? []);
}

export function answerHint(prompt: InteractivePrompt): string {
  if (prompt.multi_select) return t("Type the numbers you choose, e.g. 1 3");
  if (choices(prompt).length === 0) return t("Type your reply…");
  return prompt.custom_option_index !== null
    ? t("Type {range} or your own reply…", { range: range(prompt) })
    : t("Type {range} to choose…", { range: range(prompt) });
}

export function answerRefusal(prompt: InteractivePrompt): string {
  return prompt.multi_select
    ? t("Choose with the option numbers above, e.g. 1 3.")
    : t("Choose one of the options above: type {range}.", { range: range(prompt) });
}

export function needsConfirmation(prompt: InteractivePrompt, answer: TypedAnswer): boolean {
  return (prompt.kind === "approval" || prompt.kind === "plan" || prompt.kind === "menu") && answer.option_index !== undefined;
}

export type PressOrigin = "keyboard" | "mouse" | "touch" | "pen" | "unknown";

/**
 * Asked of the press itself and not of the device: a laptop with a touch screen reports a fine pointer and is still tapped, and a tablet with a keyboard
 * reports a coarse one. A click names its pointer in `pointerType`, and so does the pointerdown on
 * that button before it (`downType`): a finger or a pen in either one wins, since iOS Safari has
 * called a tap's click a mouse's (WebKit bug 282988). A key's click (Enter, Space) has no pointer
 * and a `detail` of 0, and so has a script's `click()` or an assistive technology's activation,
 * which is why a key also needs its keydown on that button (`keyed`).
 */
export function pressOrigin(press: { pointerType?: string; downType?: string; detail?: number; keyed: boolean } | undefined): PressOrigin {
  if (press === undefined) return "keyboard";
  for (const pointer of ["touch", "pen", "mouse"] as const) {
    if (press.downType === pointer || press.pointerType === pointer) return pointer;
  }
  return press.detail === 0 && press.keyed ? "keyboard" : "unknown";
}

/** Never after a tap or a pen: focus in the message box would raise the on-screen keyboard. */
export function focusFollowsAnswer({ fromCard, origin, coarse, cardMounted, inCard, onPage }: { fromCard: boolean; origin: PressOrigin; coarse: boolean; cardMounted: boolean; inCard: boolean; onPage: boolean }): boolean {
  const pressed = origin === "keyboard" || origin === "mouse" || (origin === "unknown" && !coarse);
  return fromCard && pressed && cardMounted && (inCard || onPage);
}
