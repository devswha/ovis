import { afterEach, expect, it } from "bun:test";
import { FRAME_DATA } from "../../server/herdr-core/connection.ts";
import { place } from "../testing/fixtures/fixture.ts";
import { Run } from "../testing/run.ts";

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

const HISTORY = Array.from({ length: 32 }, (_, row) => {
  if (row === 0) return "Old needle";
  if (row === 14) return "Middle needle";
  if (row === 29) return "Recent needle";
  if (row === 30) return "upper words";
  if (row === 31) return "alpha beta gamma";
  return `row-${row}`;
}).join("\r\n") + "\r";

async function start(paint = HISTORY): Promise<Run> {
  const run = await Run.start({
    cols: 60, rows: 14,
    fixture: { build(core) { place(core, { space: "work", spaceName: "work", tab: "one", tabName: "one" }, paint); } },
  });
  runs.push(run);
  await run.live();
  await run.advance(1);
  await run.keys("ctrl+b,[");
  return run;
}

const clips = (run: Run) => [...run.host.output().matchAll(/\x1b]52;c;([A-Za-z0-9+/=]+)\x1b\\/g)]
  .map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8"));
const data = (run: Run) => run.sent.filter(({ kind, channel }) => kind === FRAME_DATA && channel !== 0)
  .map(({ payload }) => Buffer.from(payload).toString());

it.each([
  ["l", "l", "l"],
  ["h", "l,l,h", "l"],
  ["k", "k", "u"],
  ["j", "k,j", "a"],
  ["w", "w", "b"],
  ["b", "w,w,b", "b"],
  ["0", "w,0", "a"],
  ["$", "l,$", "a"],
  ["g", "g", "O"],
  ["G", "g,G", "a"],
  ["ctrl+u", "ctrl+u,l,l,l,l", "2"],
  ["ctrl+d", "ctrl+u,ctrl+d", "a"],
  ["arrows", "up,right,down,left", "a"],
])("key table: %s", async (_key, keys, text) => {
  const run = await start();
  await run.keys(`${keys},v,y`);
  expect(clips(run)).toEqual([text]);
});

it("search finds and scrolls", async () => {
  const run = await start();
  await run.keys("/,NEEDLE,enter");
  await run.advance(10);
  expect(run.grid().map((row) => row.slice(1, 14))).toContain("Recent needle");
  await run.keys("n");
  await run.advance(10);
  expect(run.grid().map((row) => row.slice(1, 14))).toContain("Middle needle");
  expect(run.grid().map((row) => row.slice(1, 14))).not.toContain("Recent needle");
  await run.keys("N");
  await run.advance(10);
  expect(run.grid().map((row) => row.slice(1, 14))).toContain("Recent needle");
  expect(run.grid().map((row) => row.slice(1, 14))).not.toContain("Middle needle");
});

it("copy is one OSC 52 write with the selected text", async () => {
  const run = await start("left\r\n한글 e\u0301\r");
  await run.keys("v,l,l,l,y");
  expect(clips(run)).toEqual(["한글 e\u0301"]);
  expect(run.loop.model().mode.name).toBe("terminal");
  expect(run.loop.model().notices.at(-1)).toMatchObject({ code: "copied", calm: true });
});

it("line selection extends across both rows when moving backwards", async () => {
  const run = await start("left\r\nright\r");
  await run.keys("V,k,y");
  expect(clips(run)).toEqual(["left\nright"]);
});

it("nothing reaches the pane", async () => {
  const run = await start();
  run.forget();
  await run.keys(Array.from({ length: 30 }, (_, i) => ["h", "j", "x", "ctrl+b", "["][i % 5]).join(","));
  run.type("\x1b[200~paste that never reaches the program\x1b[201~");
  await run.keys("press@4:4,release@4:4");
  expect(data(run)).toEqual([]);
  run.type("qdiscard");
  await run.advance(1);
  expect(data(run)).toEqual([]);
  await run.keys("Z");
  expect(data(run)).toEqual(["Z"]);
});

it.each([
  ["1", "https://example.org/a"],
  ["2", "./docs/guide.md:12"],
  ["3", "c0ffee42"],
])("hints on a fixture screen: %s", async (digit, target) => {
  const run = await start("한 https://example.org/a\r\n./docs/guide.md:12 c0ffee42\r");
  await run.keys("f");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 10)).toBe("한 1ttps:/");
  expect(run.grid()[3]?.slice(1, 25)).toBe("2/docs/guide.md:12 30ffe");
  await run.keys(digit);
  expect(clips(run)).toEqual([target]);
});

it("resize cancels copy without sending its input to the replacement", async () => {
  const run = await start();
  await run.keys("g,v,l");
  run.host.resize(61, 14);
  await run.live();
  expect(run.loop.model().mode.name).toBe("terminal");
  expect(clips(run)).toEqual([]);
});

it("output invalidates a displayed hint before its label can copy stale text", async () => {
  const run = await start("https://example.org/a\r");
  await run.keys("f");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 6)).toBe("1ttps");
  run.core.program("t1").output("https://example.org/b\r");
  await run.advance(10);
  await run.keys("1");
  expect(clips(run)).toEqual([]);
});

it("Escape leaves the search prompt and restores the original viewport", async () => {
  const run = await start();
  await run.keys("g,/,que,backspace");
  await run.advance(10);
  expect(run.grid()[13]?.slice(0, 10)).toBe(" COPY  /qu");
  expect(run.grid()[2]?.slice(1, 11)).toBe("Old needle");
  await run.keys("esc");
  await run.advance(160);
  expect(run.grid()[11]?.slice(1, 17)).toBe("alpha beta gamma");
});

it("a missing or empty query does not move history", async () => {
  const run = await start();
  await run.keys("g,/,not-in-this-history,enter,n");
  await run.advance(10);
  expect(run.grid()[13]?.slice(7, 15)).toBe("No match");
  await run.keys("/,enter,N");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 11)).toBe("Old needle");
  expect(run.grid()[13]?.slice(7, 15)).not.toBe("No match");
});

it("an alternate screen change drops the previous buffer's selection", async () => {
  const run = await start();
  await run.keys("g,v,l");
  run.core.program("t1").output("\x1b[?1049h\x1b[HALT\r");
  await run.advance(10);
  expect(run.loop.model().mode.name).toBe("terminal");
  expect(run.grid()[2]?.slice(1, 4)).toBe("ALT");
  expect(clips(run)).toEqual([]);
});

it("hint labels skip malformed schemes and copy extensionless paths literally", async () => {
  const run = await start("javascript://host/src/a.ts https:// /var/log/messages\r");
  await run.keys("f");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 54)).toBe("javascript://host/src/a.ts https:// 1var/log/messages");
  await run.keys("1");
  expect(clips(run)).toEqual(["/var/log/messages"]);
});

it("half pages scroll the viewport while the cursor can still be visible", async () => {
  const run = await start();
  await run.keys("ctrl+u");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 7)).toBe("row-17");
  await run.keys("ctrl+d");
  await run.advance(10);
  expect(run.grid()[2]?.slice(1, 7)).toBe("row-22");
});

it("repeated cancels and re-entry never reuse the previous selection or query", async () => {
  const run = await start();
  await run.keys("g,V,/,needle,esc");
  await run.advance(160);
  await run.keys("ctrl+b,[,n,y,q,ctrl+b,[,v,y");
  expect(clips(run)).toEqual(["a"]);
  expect(data(run)).toEqual([]);
});

it("copy swallows commands while synchronized output hides the new cells", async () => {
  const run = await start();
  run.core.program("t1").output("\x1b[?2026hNEW");
  await run.advance(10);
  await run.keys("v,y");
  expect(run.loop.model().mode.name).toBe("copy");
  expect(clips(run)).toEqual([]);
  expect(data(run)).toEqual([]);
});
