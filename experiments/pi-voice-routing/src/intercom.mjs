import { NativeIntercomClient } from "pi-intercom/client";

/** Uses the pinned public client's feature negotiation; never starts or replaces a broker. */
export function createEndpoint(id, kind, onProblem = () => {}) {
  const client = new NativeIntercomClient({
    id, name: id, kind, cwd: process.cwd(), offlineDelivery: "reject",
  });
  client.on("client_error", () => onProblem("Intercom transport error; End and inspect the local broker."));
  client.on("roster_error", () => onProblem("Could not refresh the intercom roster."));
  return {
    get connected() { return client.connected; },
    connect: () => client.connect({ startBroker: false }),
    disconnect: () => client.disconnect(),
    listSessions: () => client.listSessions(),
    sendExact: (target, options) => client.sendExact(target, options),
    onMessage: (handler) => client.onMessage(handler),
    onDisconnected: (handler) => client.onDisconnected(handler),
  };
}
