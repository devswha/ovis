import { expect, it } from "bun:test";

import { svgFigurePalette, svgFigureUrl } from "./svgFigure.ts";

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
