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

/** The longest fence drawn as a figure (UTF-16 units); a longer one stays a code block. */
export const SVG_FIGURE_MAX_LENGTH = 256 * 1024;

/**
 * Markup that could run code or load something if the figure were ever drawn outside an <img>:
 * scripts, event handlers, foreignObject, a DOCTYPE (entities), a stylesheet import or link, an
 * href or url() that leaves the figure (only `#id` stays inside), CSS image-set(), an animation of
 * an href, and a CSS escape in a style (which could spell `url`). An image document already runs
 * and fetches none of it; a figure holding any of it is not drawn, so the code block shows what
 * the agent sent.
 */
const UNSAFE = [
  /<\s*(?:[\w.-]+:)?(?:script|foreignObject)\b/i,
  /\son[a-z]+\s*=/i,
  /<!\s*(?:DOCTYPE|ENTITY)/i,
  /<\?xml-stylesheet/i,
  /@import/i,
  /\bhref\s*=(?!\s*["']?\s*#)/i,
  /\burl\((?!\s*["']?\s*#)/i,
  /image-set\(/i,
  /\battributeName\s*=\s*["']?\s*(?:[\w.-]+:)?href/i,
];
/** A style (element or attribute) with a backslash anywhere: a CSS escape could spell `url`. */
const STYLED = /<\s*(?:[\w.-]+:)?style\b|\bstyle\s*=/i;

/** A numeric character reference, which XML reads as its character in a name or a value (`u&#114;l(`). */
const CHARACTER_REFERENCE = /&#(?:[xX]0*([0-9a-fA-F]{1,6})|0*(\d{1,7}));?/g;

/**
 * Every pattern above is tried on the markup as it is drawn (so a token cannot assemble one), with
 * its numeric character references read as the characters they stand for.
 */
function unsafe(svg: string): boolean {
  const read = svg.replace(CHARACTER_REFERENCE, (_reference, hex: string | undefined, decimal: string | undefined) => {
    const code = hex !== undefined ? Number.parseInt(hex, 16) : Number(decimal);
    return code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
  return UNSAFE.some((pattern) => pattern.test(read)) || (read.includes("\\") && STYLED.test(read));
}

/** An XML declaration the root may follow; nothing else (a comment, whitespace aside) may come first. */
const DECLARATION = /^<\?xml\s[^?]{0,200}\?>\s*/;
const ROOT_START = /^<(?:[\w.-]+:)?svg(?=[\s/>])/;
const CLOSE_TAG = /<\/(?:[\w.-]+:)?svg\s*>$/;

/** Where the start tag opening at 0 ends (its `>`, quotes respected), or -1 when it does not end. */
function tagEnd(text: string): number {
  let quote = "";
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote) { if (char === quote) quote = ""; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index;
  }
  return -1;
}

/** Most characters, spaces aside, a `var(--name, fallback)` fallback is read for; a longer one is left as written. */
const MAX_FALLBACK = 200;
const SPACE = /\s/;

/**
 * `var(--name)` / `var(--name, fallback)` (the fallback may hold one level of parentheses,
 * `rgb(…)`) as `value(name, fallback)`. One pass: spaces are stepped over, and each reference is
 * read for at most MAX_FALLBACK other characters, so no input makes it slow.
 */
function resolveTokens(text: string, value: (name: string, fallback: string) => string): string {
  const skip = (index: number): number => { while (index < text.length && SPACE.test(text[index]!)) index += 1; return index; };
  let out = "";
  let from = 0;
  for (let start = text.indexOf("var(", from); start !== -1; start = text.indexOf("var(", from)) {
    const nameAt = skip(start + 4);
    const name = /^--([\w-]{1,64})/.exec(text.slice(nameAt, nameAt + 67));
    const after = name === null ? -1 : skip(nameAt + name[0].length);
    const separator = after === -1 ? "" : text[after];
    if (name === null || (separator !== "," && separator !== ")")) { out += text.slice(from, start + 4); from = start + 4; continue; }
    let end = after + 1;
    let fallback = "";
    if (separator === ",") {
      let depth = 0;
      let close = -1;
      let read = 0;
      for (let index = end; index < text.length && read <= MAX_FALLBACK; index += 1) {
        const char = text[index]!;
        if (char === "(") { depth += 1; if (depth > 1) break; }
        else if (char === ")") { if (depth === 0) { close = index; break; } depth -= 1; }
        if (!SPACE.test(char)) read += 1;
      }
      if (close === -1) { out += text.slice(from, start + 4); from = start + 4; continue; }
      fallback = text.slice(end, close).trim();
      end = close + 1;
    }
    out += text.slice(from, start) + value(name[1]!, fallback);
    from = end;
  }
  return out + text.slice(from);
}
const VIEW_BOX = /\sviewBox\s*=\s*["']\s*[-\d.eE+]+[\s,]+[-\d.eE+]+[\s,]+([\d.eE+]+)[\s,]+([\d.eE+]+)\s*["']/;

/**
 * A fence's source as a data: URL the chat draws as an image, or null while it is not a whole
 * figure yet (a reply still streaming, or not SVG at all: the root comes first, after an XML
 * declaration at most), past the size cap, holding markup that could run or load something
 * (UNSAFE), or not text a URL can carry (a lone surrogate), which keeps the fence a code block.
 * Tokens become the palette's colors (an unknown name takes its fallback, else the text color).
 * The root gets what an image document cannot inherit from the page: `color` for `currentColor`,
 * a sans-serif `font-family`, the SVG namespace, and a size from its `viewBox` when it has none
 * (one unit is one CSS pixel), so the figure is not drawn at the 300×150 an unsized image gets.
 */
export function svgFigureUrl(source: string, palette: SvgFigurePalette): string | null {
  if (source.length > SVG_FIGURE_MAX_LENGTH) return null;
  const trimmed = source.trim();
  const head = DECLARATION.exec(trimmed)?.[0] ?? "";
  if (!ROOT_START.test(trimmed.slice(head.length)) || !CLOSE_TAG.test(trimmed.slice(-256))) return null;
  const fg = palette.fg ?? "currentColor";
  const resolved = resolveTokens(trimmed.slice(head.length), (name, fallback) =>
    (Object.hasOwn(palette, name) ? palette[name as keyof SvgFigurePalette] : undefined) ?? (fallback || fg));
  const end = tagEnd(resolved);
  if (end === -1) return null;
  const usesXlink = resolved.includes("xlink:");
  const tag = resolved.slice(0, end + 1);
  const root = (() => {
    let added = "";
    if (!/\scolor\s*=/.test(tag)) added += ` color="${fg}"`;
    if (!/\sfont-family\s*=/.test(tag)) added += ` font-family="sans-serif"`;
    if (!/\sxmlns\s*=/.test(tag)) added += ` xmlns="http://www.w3.org/2000/svg"`;
    if (usesXlink && !/\sxmlns:xlink\s*=/.test(tag)) added += ` xmlns:xlink="http://www.w3.org/1999/xlink"`;
    const box = VIEW_BOX.exec(tag);
    if (box !== null && !/\swidth\s*=/.test(tag) && !/\sheight\s*=/.test(tag)) added += ` width="${box[1]}" height="${box[2]}"`;
    return added ? tag.replace(/^<[^\s/>]+/, `$&${added}`) : tag;
  })();
  const svg = root + resolved.slice(end + 1);
  if (unsafe(svg)) return null;
  try {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch {
    // a lone surrogate: no URL carries it
    return null;
  }
}
