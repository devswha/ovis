export const FAKE_TARGET = Object.freeze({
  id: "example-pi-session", endpointEpoch: "example-epoch-1", kind: "agent", ready: true, name: "Example Pi",
});

/** In-memory transport only. Does not import intercom or connect to a socket. */
export function fakeEndpoint() {
  let connected = false;
  const messages = new Set();
  const disconnects = new Set();
  return {
    get connected() { return connected; },
    async connect() { connected = true; },
    async disconnect() {
      if (!connected) return;
      connected = false;
      for (const handler of disconnects) handler();
    },
    async listSessions() { return [{ ...FAKE_TARGET }]; },
    async sendExact(target, options) {
      if (!connected || target.id !== FAKE_TARGET.id || target.endpointEpoch !== FAKE_TARGET.endpointEpoch) {
        return { delivery: "failed", outcomeKnown: true };
      }
      queueMicrotask(() => {
        if (connected) for (const handler of messages) handler(FAKE_TARGET, { content: { text: `Fake reply: ${options.text}` } });
      });
      return { delivery: "socket_delivered", outcomeKnown: true };
    },
    onMessage(handler) { messages.add(handler); return () => messages.delete(handler); },
    onDisconnected(handler) { disconnects.add(handler); return () => disconnects.delete(handler); },
  };
}
