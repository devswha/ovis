// The server of one of the core's other machines (machine-bridge.ts starts it): herdr's API answered
// from that machine's terminals through this PC's core, served on loopback to the server that
// started it, as an SSH PC's bridge serves its own (server/remote-entry.ts).
import { randomBytes } from "node:crypto";
import { createServer } from "../index.ts";
import { hcMachine, setRuntime, startRuntime } from "./runtime.ts";

const stateDir = process.env["OVIS_HC_MACHINE_STATE"];
if (hcMachine() === null || !stateDir) throw new Error("machine-entry.ts runs only as machine-bridge.ts starts it");
setRuntime("herdr-core");
const core = await startRuntime(stateDir);
const token = randomBytes(32).toString("hex");
const server = createServer({ port: 0, hostname: "127.0.0.1", token, machines: false, bridgeOnly: true, stateDir });
process.send?.({ type: "ready", port: server.port, token });
// the server that started this one holds its stdin open: once that ends, so does this one
for await (const _chunk of Bun.stdin.stream()) { /* nothing is read */ }
server.stop();
core?.stop();
process.exit(0);
