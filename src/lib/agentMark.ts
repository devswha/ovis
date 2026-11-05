const OTHER_CONTROL = /\p{C}/gu;

/**
 * Unknown agent labels can contain private-use Nerd Font glyphs. They are data,
 * not a usable fallback initial, so remove them before drawing the fallback mark.
 */
export function fallbackInitial(agent: string): string {
  const clean = agent.normalize("NFKC").replace(OTHER_CONTROL, "").trim();
  return [...clean][0]?.toUpperCase() ?? "?";
}

/** the terminal colors a fallback mark is tinted with (src/styles.css `--term-*`, in every theme) */
const MARK_HUES = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;

/** The color a kind without a mark of its own is drawn in: the same for the same kind, on every device. */
export function fallbackHue(agent: string): (typeof MARK_HUES)[number] {
  let hash = 0;
  for (const char of agent.trim().toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return MARK_HUES[hash % MARK_HUES.length]!;
}
