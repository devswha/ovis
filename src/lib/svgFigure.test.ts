import { expect, it } from "bun:test";

import { SVG_FIGURE_MAX_LENGTH, svgFigurePalette, svgFigureUrl } from "./svgFigure.ts";

const decode = (url: string | null): string => {
  expect(url).not.toBeNull();
  const prefix = "data:image/svg+xml;charset=utf-8,";
  expect(url!.startsWith(prefix)).toBe(true);
  return decodeURIComponent(url!.slice(prefix.length));
};

it("keeps a fence that is not a whole figure yet as code", () => {
  expect(svgFigureUrl('<svg viewBox="0 0 10 10"><rect', { fg: "#fff" })).toBeNull();
  expect(svgFigureUrl("not svg at all", { fg: "#fff" })).toBeNull();
});

it("resolves theme tokens, a fallback for an unknown one, and the text color otherwise", () => {
  const svg = decode(svgFigureUrl(
    '<svg viewBox="0 0 10 10"><rect fill="var(--accent)"/><rect fill="var(--nope, rgb(1, 2, 3))"/><rect fill="var(--nope)"/></svg>',
    { fg: "#eee", accent: "#f0a830" },
  ));
  expect(svg).toContain('fill="#f0a830"');
  expect(svg).toContain('fill="rgb(1, 2, 3)"');
  expect(svg).toContain('fill="#eee"');
  expect(svg).not.toContain("var(");
});

it("gives the root what an image document cannot inherit, and keeps what it already says", () => {
  const sized = decode(svgFigureUrl('<svg viewBox="0 0 900 560"><text fill="currentColor">x</text></svg>', { fg: "#eee" }));
  expect(sized).toMatch(/^<svg color="#eee" font-family="sans-serif" xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="900" height="560" viewBox/);

  const own = decode(svgFigureUrl('<svg xmlns="http://www.w3.org/2000/svg" width="40" color="red" viewBox="0 0 900 560"></svg>', { fg: "#eee" }));
  expect(own).not.toContain('color="#eee"');
  expect(own).not.toContain('width="900"');
});

it("reads each token from its theme role", () => {
  const roles: Record<string, string> = { "--text": " #d8d0c3 ", "--status-done": "#93c36b" };
  const palette = svgFigurePalette((property) => roles[property] ?? "");
  expect(palette).toEqual({ fg: "#d8d0c3", success: "#93c36b" });
});

it("keeps a figure that could run or load something as code", () => {
  const unsafe = [
    '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>',
    '<svg viewBox="0 0 10 10" onload="alert(1)"></svg>',
    '<svg viewBox="0 0 10 10"><rect ONCLICK = "x()"/></svg>',
    '<svg viewBox="0 0 10 10"><foreignObject><div>x</div></foreignObject></svg>',
    '<svg viewBox="0 0 10 10"><image href="https://example.com/a.png"/></svg>',
    '<svg viewBox="0 0 10 10"><use xlink:href="other.svg#a"/></svg>',
    '<svg viewBox="0 0 10 10"><image href = " data:image/png;base64,AAAA"/></svg>',
    '<svg viewBox="0 0 10 10"><a href="javascript:alert(1)"><rect/></a></svg>',
    '<svg viewBox="0 0 10 10"><rect style="fill: url(https://example.com/x)"/></svg>',
    '<svg viewBox="0 0 10 10"><style>@import "https://example.com/x.css";</style></svg>',
    '<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg viewBox="0 0 10 10"><text>&a;</text></svg>',
  ];
  for (const source of unsafe) expect(svgFigureUrl(source, { fg: "#eee" })).toBeNull();
});

it("draws a figure whose references stay inside it", () => {
  const svg = decode(svgFigureUrl(
    '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"/><path id="p" d="M0 0"/></defs><rect fill="url(#g)" style="fill: url( \'#g\' )"/><use href="#p"/><use xlink:href = \' #p\'/></svg>',
    { fg: "#eee" },
  ));
  expect(svg).toContain('fill="url(#g)"');
});

it("keeps a figure past the size cap as code", () => {
  const body = "<rect/>".repeat(Math.ceil(SVG_FIGURE_MAX_LENGTH / 7));
  expect(svgFigureUrl(`<svg viewBox="0 0 10 10">${body}</svg>`, { fg: "#eee" })).toBeNull();
});
