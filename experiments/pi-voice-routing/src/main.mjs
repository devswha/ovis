import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import { Routing } from "./routing.mjs";

// Broker labels and replies are untrusted terminal content. Bound output and remove controls.
export function printable(value) {
  return stripVTControlCharacters(String(value).slice(0, 32768)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !["--fake", "--local"].includes(args[0])) {
    throw new Error("Usage: node src/main.mjs --fake|--local");
  }
  const output = (message) => console.log(printable(message));
  const createEndpoint = args[0] === "--fake"
    ? (await import("./fake.mjs")).fakeEndpoint
    : (await import("./intercom.mjs")).createEndpoint;
  const observer = createEndpoint(`pi-routing-observer-${randomUUID()}`, "service", output);
  const routing = new Routing(observer, (id) => createEndpoint(id, "human", output), (event) => output(`Reply: ${event.text}`));
  let lines;
  let interrupted = false;
  let roster = [];
  const interrupt = () => { interrupted = true; lines?.close(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await observer.connect();
    if (interrupted) return;
    lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    output(`Pi routing experiment (no audio). Mode: ${args[0].slice(2)}`);
    output("Commands: list | select <row> | send <text> | end | quit. Send may trigger paid Pi work in local mode.");
    for await (const line of lines) {
      const separator = line.indexOf(" ");
      const command = separator < 0 ? line : line.slice(0, separator);
      const body = separator < 0 ? "" : line.slice(separator + 1);
      try {
        if (command === "quit") break;
        if (command === "list") {
          roster = await routing.list();
          for (const [index, row] of roster.entries()) output(`${index + 1}: ${row.name ?? "Pi"} [${row.id}] epoch=${row.endpointEpoch}`);
          if (!roster.length) output("No live Pi targets.");
        } else if (command === "select") {
          const row = /^[1-9][0-9]*$/.test(body) ? roster[Number(body) - 1] : null;
          if (!row) throw new Error("List targets and choose an exact row number.");
          await routing.select(row.id, row.endpointEpoch);
          output(`Selected [${row.id}] epoch=${row.endpointEpoch}`);
        } else if (command === "send") {
          const result = await routing.send(body);
          output(`Delivery: ${result.delivery}; outcome known: ${result.outcomeKnown}. This is not proof the agent acted.`);
        } else if (command === "end") {
          await routing.end();
          output("Ended. Already dispatched Pi work is not cancelled.");
        } else output("Unknown command. Nothing sent.");
      } catch (error) { output(error.message); }
    }
  } finally {
    lines?.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    try { await routing.end(); }
    finally { await observer.disconnect(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Pi routing experiment failed. Check the selected mode, profile and compatible broker; no reconnect attempted.");
    process.exitCode = 1;
  });
}
