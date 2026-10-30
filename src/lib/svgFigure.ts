// ```svg fences in chat: agents that draw figures (omp's assistant ```svg blocks) color them with
// a small token vocabulary, `var(--fg)`, `var(--muted)`, ... `var(--c6)` plus `currentColor`, on
// a transparent background. The figure is shown as an <img> from a data: URL, so its markup never
// joins the page: a script, an event handler or an external reference in it does nothing. An image
// document does not see the page's CSS variables, so the tokens are resolved here to the theme's
// current colors before the URL is made.

/** Each figure token, as the theme role (src/styles.css) that colors it. */
export const SVG_FIGURE_ROLES = {
  fg: "text",
  muted: "text-dim",
  border: "border",
  surface: "bg-elevated",
  accent: "accent",
  success: "status-done",
  warning: "notice",
  error: "status-blocked",
  c1: "syntax-function",
  c2: "syntax-keyword",
  c3: "syntax-string",
  c4: "syntax-number",
  c5: "syntax-type",
  c6: "syntax-variable",
} as const;

export type SvgFigurePalette = Partial<Record<keyof typeof SVG_FIGURE_ROLES, string>>;

/** The figure tokens in the page's current theme; `read` is `getComputedStyle(root).getPropertyValue`. */
export function svgFigurePalette(read: (property: string) => string): SvgFigurePalette {
  const palette: SvgFigurePalette = {};
  for (const [token, role] of Object.entries(SVG_FIGURE_ROLES) as [keyof typeof SVG_FIGURE_ROLES, string][]) {
    const value = read(`--${role}`).trim();
    if (value) palette[token] = value;
  }
  return palette;
}

/** `var(--name)` / `var(--name, fallback)`; the fallback may hold one level of parentheses (`rgb(…)`). */
const VAR_REFERENCE = /var\(\s*--([\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;
/** The first `<svg …>` start tag (a namespace prefix allowed). */
const ROOT_TAG = /<(?:[\w.-]+:)?svg(?=[\s/>])[^>]*>/;
const CLOSE_TAG = /<\/(?:[\w.-]+:)?svg\s*>\s*$/;
const VIEW_BOX = /\sviewBox\s*=\s*["']\s*[-\d.eE+]+[\s,]+[-\d.eE+]+[\s,]+([\d.eE+]+)[\s,]+([\d.eE+]+)\s*["']/;

/**
 * A fence's source as a data: URL the chat draws as an image, or null while it is not a whole
 * figure yet (a reply still streaming, or not SVG at all), which keeps the fence a code block.
 * Tokens become the palette's colors (an unknown name takes its fallback, else the text color).
 * The root gets what an image document cannot inherit from the page: `color` for `currentColor`,
 * a sans-serif `font-family`, the SVG namespace, and a size from its `viewBox` when it has none
 * (one unit is one CSS pixel), so the figure is not drawn at the 300×150 an unsized image gets.
 */
export function svgFigureUrl(source: string, palette: SvgFigurePalette): string | null {
  const trimmed = source.trim();
  const root = ROOT_TAG.exec(trimmed);
  if (root === null || !CLOSE_TAG.test(trimmed)) return null;
  const fg = palette.fg ?? "currentColor";
  const lookup = palette as Record<string, string | undefined>;
  const resolved = trimmed.replace(VAR_REFERENCE, (_match, name: string, fallback: string | undefined) => lookup[name] ?? (fallback?.trim() || fg));
  const usesXlink = resolved.includes("xlink:");
  const svg = resolved.replace(ROOT_TAG, (tag) => {
    let added = "";
    if (!/\scolor\s*=/.test(tag)) added += ` color="${fg}"`;
    if (!/\sfont-family\s*=/.test(tag)) added += ` font-family="sans-serif"`;
    if (!/\sxmlns\s*=/.test(tag)) added += ` xmlns="http://www.w3.org/2000/svg"`;
    if (usesXlink && !/\sxmlns:xlink\s*=/.test(tag)) added += ` xmlns:xlink="http://www.w3.org/1999/xlink"`;
    const box = VIEW_BOX.exec(tag);
    if (box !== null && !/\swidth\s*=/.test(tag) && !/\sheight\s*=/.test(tag)) added += ` width="${box[1]}" height="${box[2]}"`;
    return added ? tag.replace(/^<[^\s/>]+/, `$&${added}`) : tag;
  });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
