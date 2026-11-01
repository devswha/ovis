import { randomUUID } from "node:crypto";

export function agentTargets(rows) {
  return rows.filter((row) => row.kind === "agent" && row.ready === true &&
    typeof row.id === "string" && row.id.length > 0 &&
    typeof row.endpointEpoch === "string" && row.endpointEpoch.length > 0);
}

function same(left, right) {
  return left?.id === right?.id && left?.endpointEpoch === right?.endpointEpoch;
}

/** One explicit selection owns one short-lived human endpoint. No retries or reconnects. */
export class Routing {
  #observer;
  #createHuman;
  #active = null;
  #generation = 0;
  #publish;

  constructor(observer, createHuman, publish = () => {}) {
    this.#observer = observer;
    this.#createHuman = createHuman;
    this.#publish = publish;
    observer.onDisconnected(() => { void this.end().catch(() => {}); });
  }

  async list() {
    return agentTargets(await this.#observer.listSessions());
  }

  async select(id, endpointEpoch) {
    const generation = this.#generation + 1;
    await this.end();
    if (generation !== this.#generation) throw new Error("Selection superseded.");
    const matches = (await this.list()).filter((row) => same(row, { id, endpointEpoch }));
    if (generation !== this.#generation || matches.length !== 1) throw new Error("Target is absent or stale; list and select again.");
    const human = this.#createHuman(`pi-routing-human-${randomUUID()}`);
    const active = { human, target: { id, endpointEpoch }, generation, sending: false, uncertain: false };
    this.#active = active;
    human.onMessage((from, message) => {
      if (this.#active === active && human.connected && same(from, active.target)) {
        this.#publish({ type: "reply", text: message.content.text });
      }
    });
    human.onDisconnected(() => {
      if (this.#active === active) void this.end().catch(() => {});
    });
    try {
      await human.connect();
      if (this.#active !== active || !human.connected) throw new Error("Selection ended during connection.");
      const current = (await this.list()).filter((row) => same(row, active.target));
      if (this.#active !== active || current.length !== 1) throw new Error("Target changed during selection.");
    } catch (error) {
      if (this.#active === active) await this.end();
      else await human.disconnect();
      throw error;
    }
  }

  async send(text) {
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 16 * 1024) {
      throw new Error("Send requires 1 to 16384 bytes of nonblank text.");
    }
    const active = this.#active;
    if (!active || active.sending || active.uncertain) throw new Error("Select a target first; an uncertain send requires End and a new selection.");
    active.sending = true;
    try {
      const matches = (await this.list()).filter((row) => same(row, active.target));
      if (this.#active !== active || !active.human.connected || matches.length !== 1) {
        if (this.#active === active) await this.end();
        throw new Error("Target disconnected or changed; nothing was sent.");
      }
      let result;
      try {
        result = await active.human.sendExact(active.target, { text, messageId: randomUUID() });
      } catch {
        active.uncertain = true;
        throw new Error("Delivery outcome unknown. Do not resend automatically. End and inspect the target session.");
      }
      if (!result.outcomeKnown || result.delivery === "unknown") active.uncertain = true;
      return { delivery: result.delivery, outcomeKnown: result.outcomeKnown };
    } finally {
      active.sending = false;
    }
  }

  async end() {
    this.#generation++;
    const active = this.#active;
    this.#active = null; // Fence all callbacks before transport teardown.
    if (active) await active.human.disconnect();
  }
}
