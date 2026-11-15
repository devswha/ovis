import { createServer } from "../server/index.ts";
import { startRuntime } from "../server/herdr-core/runtime.ts";

const stateDir = process.env["OVIS_STATE_DIR"];
if (!stateDir || !process.env["HC_SOCKET"] || !process.env["HC_SESSION"]) throw new Error("An isolated core and state directory are required");
const core = await startRuntime(stateDir);
const token = crypto.randomUUID();
const server = createServer({ port: 0, hostname: "127.0.0.1", token, stateDir, machines: true });
process.send?.({ port: server.port, token });
process.on("SIGTERM", () => { server.stop(); core?.stop(); process.exit(0); });
