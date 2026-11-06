// East Asian Wide and Fullwidth ranges (Hangul, CJK, kana, fullwidth forms, wide emoji) take two
// terminal columns; combining marks and zero-width characters take none.
const WIDE = /[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{2fffd}\u{30000}-\u{3fffd}]/u;
const ZERO_WIDTH = /[\p{Mn}\p{Me}\u200b-\u200f\ufe00-\ufe0f]/u;

/** Terminal columns a row of text fills. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += ZERO_WIDTH.test(char) ? 0 : WIDE.test(char) ? 2 : 1;
  return width;
}

/** Deliberately narrow: prose mentioning passwords must not become an input prompt. */
export function secretPrompt(screen: string, columns = Infinity): string | null {
  const lines = screen.split(/\r?\n/);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  let line = lines.pop()?.trimEnd() ?? "";
  for (;;) {
    const candidate = line.trimStart();
    if (!candidate || candidate.length > 120 || /\?|y\s*\/\s*n/i.test(candidate)) return null;
    if (/^(?:\[sudo\] password for [^:]+|[^\s@]+@[^\s:]+['’]s password|password(?: for [^:]+)?|enter passphrase(?: for key ['’][^\r\n]+['’])?|enter pin(?: for [^:]+)?|(?:repeat|verify|confirm) password):$/i.test(candidate)) return candidate;
    // herdr's screen-diff stream does not preserve xterm's soft-wrap flags. Only
    // continue a row that reached the right edge (a final space can be trimmed).
    const previous = lines.pop()?.trimEnd();
    // Rows are measured in columns, as the terminal fills them.
    const width = previous ? displayWidth(previous) : 0;
    if (!previous || width < columns - 1 || width > columns) return null;
    // A wide character that does not fit in the last column moves to the next row, leaving it
    // empty; otherwise the missing column was a trimmed space. No trim of the joined text: a
    // wrapped row's leading space is part of the prompt (the candidate is trimmed).
    const wideWrap = width === columns - 1 && WIDE.test(String.fromCodePoint(line.codePointAt(0) ?? 32));
    line = previous + " ".repeat(wideWrap ? 0 : columns - width) + line;
  }
}

// a vendor's key prefix (OpenAI, Anthropic, DeepSeek and Stripe's sk-, GitHub, GitLab, Slack,
// Hugging Face, Groq, Replicate, xAI, npm, PyPI, Google, AWS), matched a few characters in so a key
// being typed is caught early; a JWT; a private key block
const KEY_SHAPES = [
  /(?:^|[^A-Za-z0-9])(?:sk|rk)[-_][A-Za-z0-9_-]{4,}/,
  /(?:^|[^A-Za-z0-9])(?:gh[pousr]_|github_pat_|glpat-|xox[abposr]-|hf_|gsk_|r8_|xai-|npm_|pypi-)[A-Za-z0-9_-]{4,}/,
  /(?:^|[^A-Za-z0-9])AIza[A-Za-z0-9_-]{4,}/,
  /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{4,}/,
  /(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * Whether text holds what looks like an API key or token (#2523): a vendor's shape, or a long run
 * mixing upper and lower case letters (and `_`) with digits, or 40 characters long without them. A `/` is
 * taken as part of a key only in a run of exactly 40 (an AWS secret key's length): anything else
 * with one is a path or a URL. A run holding a word (eight lower case letters in a row) is a name,
 * and hex alone is no key: commit hashes and image digests are kept as typed.
 */
export function looksLikeKey(text: string): boolean {
  if (KEY_SHAPES.some((shape) => shape.test(text))) return true;
  return (text.match(/[A-Za-z0-9/+_]{24,}/g) ?? []).some((run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && !/[a-z]{8}/.test(run)
    && (!run.includes("/") || run.length === 40) && (/\d/.test(run) || run.length >= 40));
}

/** A secret is one line of literal keystrokes; never allow terminal controls. */
export function validSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}
