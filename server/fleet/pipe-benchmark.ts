/**
 * The relay mux benchmark (scripts/relay-mux-benchmark.ts) for a machine session: a terminal's echo over one pipe while
 * another pipe carries 64 MiB from the machine to the controller, over the same full-duplex, FIFO, bandwidth-limited
 * carrier model (protected binary records cost plaintext + 24 bytes; crypto CPU and WebSocket framing excluded). It
 * lives here, not in scripts/, because the fleet's wire contract stays in private files (docs/fleet-link.md).
 *
 *   bun server/fleet/pipe-benchmark.ts [--base64] [--real]
 */
import assert from "node:assert/strict";
import { BenchmarkClock, BULK_BYTES } from "../../scripts/relay-mux-benchmark.ts";
import type { BenchmarkResult } from "../../scripts/relay-mux-benchmark.ts";
import { MuxEngine } from "../../shared/relay-mux-engine.ts";
import type { MuxClock } from "../../shared/relay-mux-engine.ts";
import { acceptPipe, openPipe, PIPE_DATA_BYTES, PipeFrame, pipeMuxExtension } from "./mux-ext.ts";
import type { PipeStream } from "./mux-ext.ts";

const MACHINE_ID = "00112233445566778899aabbccddeeff";

export async function benchmarkPipes(
  clock: MuxClock, rttMs: number, bulk: boolean, linkMbps = 100, wireMode: "binary" | "base64" = "binary",
): Promise<BenchmarkResult> {
  const links = { client: 0, server: 0 };
  const queues: Record<"client" | "server", { at: number; bytes: Uint8Array }[]> = { client: [], server: [] };
  const wireCost = (bytes: Uint8Array) => wireMode === "binary" ? bytes.length + 24 : Math.ceil((bytes.length + 24) / 3) * 4;
  const deliveries = new Set<() => void>();
  const echoes: number[] = [];
  const errors: string[] = [];
  let closing = false;
  let peakBulkFlight = 0;
  let peakAccounted = 0;
  let controller: MuxEngine;
  let machine: MuxEngine;
  const deliver = (role: "client" | "server") => {
    const next = queues[role][0];
    if (!next) return;
    const cancel = clock.setTimeout(() => {
      deliveries.delete(cancel);
      queues[role].shift();
      (role === "client" ? controller : machine).receive(next.bytes);
      while (queues[role][0] && queues[role][0].at <= clock.now()) {
        const due = queues[role].shift();
        if (due) (role === "client" ? controller : machine).receive(due.bytes);
      }
      deliver(role);
    }, Math.max(0, next.at - clock.now()));
    deliveries.add(cancel);
  };
  // the machine echoes the terminal pipe and sends the bulk one
  const serve = (pipe: PipeStream) => {
    pipe.accept();
    if (pipe.endpoint === "native") {
      void (async () => {
        const reader = pipe.readable.getReader();
        for (let next = await reader.read(); !next.done; next = await reader.read()) await pipe.write(next.value);
      })().catch(() => undefined);
      return;
    }
    void (async () => {
      for (let offset = 0; offset < BULK_BYTES; offset += PIPE_DATA_BYTES) {
        await pipe.write(new Uint8Array(Math.min(PIPE_DATA_BYTES, BULK_BYTES - offset)).fill(37));
      }
      await pipe.end();
    })().catch((error: unknown) => { errors.push(`machine bulk: ${String(error)}`); });
  };
  const make = (role: "client" | "server") => new MuxEngine({
    role, clock, routingOverhead: 0, maxWireMessageBytes: 65536, outboundWireByteLength: wireCost,
    extension: pipeMuxExtension, close: () => undefined,
    onExtension: (frame) => {
      const pipe = frame.type === PipeFrame.OPEN ? acceptPipe(machine, frame, ["bridge", "native"]) : undefined;
      if (pipe) serve(pipe);
    },
    onClose: (error) => { if (!closing) errors.push(`${role}: ${error.code}: ${error.message}`); },
    send: async (bytes) => {
      const finish = Math.max(clock.now(), links[role]) + wireCost(bytes) / (linkMbps * 125);
      links[role] = finish;
      queues[role].push({ at: finish + rttMs / 2, bytes });
      if (queues[role].length === 1) deliver(role);
      for (const engine of [controller, machine]) {
        peakBulkFlight = Math.max(peakBulkFlight, engine.stats.ordinaryFlightBytes);
        peakAccounted = Math.max(peakAccounted, engine.stats.accountedBytes);
      }
    },
  });
  controller = make("server");
  machine = make("client");
  controller.authenticateExtension(MACHINE_ID);
  machine.authenticateExtension(MACHINE_ID);
  let cancelProbe: (() => void) | undefined;
  let cancelDeadline: (() => void) | undefined;
  try {
    const terminal = openPipe(controller, "native");
    await new Promise<void>((resolve) => { terminal.onAccept = resolve; });
    const started = clock.now();
    let finished = false;
    let sent = 0;
    const pending = new Map<string, number>();
    let finishEcho = (): void => undefined;
    const echoDone = new Promise<void>((resolve) => { finishEcho = resolve; });
    void (async () => {
      const reader = terminal.readable.getReader();
      let text = "";
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        text += new TextDecoder().decode(next.value);
        // each key ends with a newline; the pipe may join or split them
        for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n")) {
          const key = text.slice(0, end);
          text = text.slice(end + 1);
          const sentAt = pending.get(key);
          assert.ok(sentAt !== undefined, "unexpected or duplicate echo");
          pending.delete(key);
          echoes.push(clock.now() - sentAt);
          if ((finished || !bulk && sent === 128) && !pending.size) finishEcho();
        }
      }
    })().catch((error: unknown) => { errors.push(`terminal: ${String(error)}`); });
    // writes go one at a time, as a terminal's keys do; a key waits behind the one still going out
    let typing: Promise<void> = Promise.resolve();
    const probe = () => {
      const key = `terminal-${sent++}`;
      pending.set(key, clock.now());
      typing = typing.then(() => terminal.write(new TextEncoder().encode(`${key}\n`)));
      if (!finished && (bulk || sent < 128)) cancelProbe = clock.setTimeout(probe, 37);
    };
    probe();
    let bytes = 0;
    let elapsedMs = 0;
    const bodyDone = bulk ? (async () => {
      const file = openPipe(controller, "bridge");
      const reader = file.readable.getReader();
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        assert.ok(next.value.every((byte) => byte === 37), "corrupt bulk payload");
        bytes += next.value.length;
      }
      assert.equal(bytes, BULK_BYTES);
      elapsedMs = clock.now() - started;
      finished = true;
      cancelProbe?.();
      if (!pending.size) finishEcho();
    })() : Promise.resolve();
    const deadline = new Promise<never>((_, reject) => {
      cancelDeadline = clock.setTimeout(() => reject(new Error(`benchmark timed out: ${errors.join("; ")}`)), 600_000);
    });
    await Promise.race([Promise.all([bodyDone, echoDone]), deadline]);
    assert.deepEqual(errors, []);
    const sorted = echoes.sort((a, b) => a - b);
    const echoP95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
    assert.ok(echoP95Ms !== undefined);
    return { rttMs, linkMbps, wireMode, bytes, elapsedMs, mbPerSecond: elapsedMs ? bytes / elapsedMs / 1000 : 0,
      echoSamples: echoes.length, echoP95Ms, peakBulkFlight, peakAccounted };
  } finally {
    closing = true;
    cancelDeadline?.();
    cancelProbe?.();
    for (const cancel of deliveries) cancel();
    controller.carrierLost();
    machine.carrierLost();
  }
}

if (import.meta.main) {
  const real = process.argv.includes("--real");
  const wireMode = process.argv.includes("--base64") ? "base64" : "binary";
  for (const rtt of [0, 20, 50, 100]) {
    const run = (bulk: boolean) => {
      if (!real) {
        const clock = new BenchmarkClock();
        return clock.run(benchmarkPipes(clock, rtt, bulk, 100, wireMode));
      }
      return benchmarkPipes({
        now: () => performance.now(),
        setTimeout: (callback, ms) => {
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
      }, rtt, bulk, 100, wireMode);
    };
    const idle = await run(false);
    const loaded = await run(true);
    console.log(JSON.stringify({ mode: real ? "real" : "deterministic", pipes: true, ...loaded,
      idleP95Ms: idle.echoP95Ms, latencyRatio: loaded.echoP95Ms / idle.echoP95Ms }));
  }
}
