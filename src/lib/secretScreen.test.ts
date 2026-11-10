import { expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { createSecretScreen } from "./secretScreen.ts";
import { matchHerdrWidths } from "./terminalWidths.ts";

const parse = (term: Terminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve));
const terminal = (cols: number, rows = 10): Terminal => {
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  matchHerdrWidths(term);
  return term;
};

/**
 * One screen as herdr's attach stream draws it: inside a synchronized update, every row at its own place with
 * every cell written, and the cursor last. No row is a wrapped continuation of the one above.
 */
const frame = (cols: number, rows: string[], [row, column]: [number, number]): string =>
  `\x1b[?2026h\x1b[?25l${rows.map((text, index) => `\x1b[${index + 1};1H${text.padEnd(cols)}`).join("")}\x1b[${row + 1};${column + 1}H\x1b[?25h\x1b[?2026l`;

const GIT = "Password for 'https://alice@github.com':";

test("a prompt asks while the cursor is on its line, and is answered once the cursor has left it", async () => {
  const term = terminal(80);
  const screen = createSecretScreen(term, () => true);
  try {
    await parse(term, frame(80, ["$ git push", `${GIT} `, "", ""], [1, 41]));
    expect(screen.read()).toBe(GIT);
    // git read the answer and printed its line break: the prompt is still the last text
    await parse(term, frame(80, ["$ git push", `${GIT} `, "", ""], [2, 0]));
    expect(screen.read()).toBeNull();
    // asked again in place, as after a wrong password
    await parse(term, frame(80, ["$ git push", `${GIT} `, `${GIT} `, ""], [2, 41]));
    expect(screen.read()).toBe(GIT);
    // at the screen's last row the answer's line break scrolls the prompt up, which herdr redraws a row higher
    await parse(term, frame(80, ["a", "b", "c", "d", "e", "f", "g", "h", "$ git push", `${GIT} `], [9, 41]));
    expect(screen.read()).toBe(GIT);
    await parse(term, frame(80, ["b", "c", "d", "e", "f", "g", "h", "$ git push", `${GIT} `, ""], [9, 0]));
    expect(screen.read()).toBeNull();
  } finally { term.dispose(); }
});

test("a prompt printed with its line break and read on the row below asks, whose cursor was never on it", async () => {
  const term = terminal(80);
  const screen = createSecretScreen(term, () => true);
  try {
    await parse(term, frame(80, ["$ ./setup.sh", "Password:", "", ""], [2, 0]));
    expect(screen.read()).toBe("Password:");
    await parse(term, frame(80, ["$ ./setup.sh", "Password:", "", ""], [2, 0]));
    expect(screen.read()).toBe("Password:");
  } finally { term.dispose(); }
});

test("what was seen of one pane's prompt says nothing of the next pane's", async () => {
  const term = terminal(80);
  const screen = createSecretScreen(term, () => true);
  try {
    // pane A waits at `Password: ` with the cursor on it
    await parse(term, frame(80, ["$ su", "Password: ", "", ""], [1, 10]));
    expect(screen.read()).toBe("Password:");
    // the terminal is switched to pane B, where a script printed the same words and reads below them
    term.reset();
    screen.forget();
    await parse(term, frame(80, ["$ ./setup.sh", "Password:", "", ""], [2, 0]));
    expect(screen.read()).toBe("Password:");
  } finally { term.dispose(); }
});

test("a prompt of the same words printed below an answered one is another asking", async () => {
  const term = terminal(80);
  const screen = createSecretScreen(term, () => true);
  try {
    await parse(term, frame(80, ["$ ./ask", "Password: ", "", "", ""], [1, 10]));
    expect(screen.read()).toBe("Password:");
    // answered, and before the next frame the script prints the words again with a line break and reads below them
    await parse(term, frame(80, ["$ ./ask", "Password: ", "Password:", "", ""], [3, 0]));
    expect(screen.read()).toBe("Password:");
    // that one answered in turn: nothing new was printed, and the cursor was never on it, so it asks as before
    await parse(term, frame(80, ["$ ./ask", "Password: ", "Password:", "", ""], [3, 0]));
    expect(screen.read()).toBe("Password:");
  } finally { term.dispose(); }
});

test("on a stream of the program's own bytes, a prompt xterm wrapped is answered by a line feed alone", async () => {
  // a herdr-core pane: xterm wraps the 40-column prompt at 30 columns itself and joins its rows
  const term = terminal(30);
  const screen = createSecretScreen(term, () => true);
  try {
    await parse(term, `$ git push\r\n${GIT} `);
    expect(screen.read()).toBe(GIT);
    // a reader in raw mode ends its line with a line feed: the cursor is on the next row, past its start
    await parse(term, "\n");
    expect(screen.read()).toBeNull();
  } finally { term.dispose(); }
  // and one that fills its row exactly still asks from the row below, where its wrapped space is
  const edge = terminal(40);
  const edgeScreen = createSecretScreen(edge, () => true);
  try {
    await parse(edge, `$ git push\r\n${GIT} `);
    expect(edgeScreen.read()).toBe(GIT);
    await parse(edge, "\r\n");
    expect(edgeScreen.read()).toBeNull();
  } finally { edge.dispose(); }
});

test("a pane whose cursor is not known keeps its prompt while it is the last text", async () => {
  const term = terminal(80);
  const screen = createSecretScreen(term, () => false);
  try {
    await parse(term, frame(80, ["$ git push", `${GIT} `, "", ""], [1, 41]));
    expect(screen.read()).toBe(GIT);
    await parse(term, frame(80, ["$ git push", `${GIT} `, "", ""], [2, 0]));
    expect(screen.read()).toBe(GIT);
  } finally { term.dispose(); }
});
