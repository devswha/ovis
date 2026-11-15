import { readFileSync } from "node:fs";

/**
 * The ports the system hands out for port 0, first and last. Linux says them, and a host can set
 * them; elsewhere, and where that cannot be read, every port from Linux's default first one up
 * counts (macOS and Windows hand out 49152 and up).
 */
function handedOut(): [number, number] {
  try {
    const [first, last] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
    if (Number.isInteger(first) && Number.isInteger(last) && first! >= 1 && first! <= last! && last! <= 65535) return [first!, last!];
  } catch { /* not Linux, or not to be read */ }
  return [32768, 65535];
}

/**
 * The ports to pick from, first and last, given the ones the system hands out: a stretch of at
 * least a thousand that holds none of them, or null when the system hands out nearly every port.
 * From 20000 up when that fits: server/updater.test.ts picks its own below it.
 */
export function quietRange(first: number, last: number): [number, number] | null {
  const stretches: [number, number][] = [[20_000, first - 1], [last + 1, 65_535], [1024, Math.min(first - 1, 19_999)]];
  return stretches.find(([from, to]) => to - from + 1 >= 1000) ?? null;
}

/**
 * Ports a test never picks, binds or hands to a program: the default port of the owner's own Ovis (7317) and the
 * maintainer's test app on this PC (17421). A request a test sends there reaches a live app.
 */
export const OWNER_PORTS: ReadonlySet<number> = new Set([7317, 17421]);

/**
 * A loopback port this test holds for as long as it keeps the listener: whatever connects there is closed at once, so a
 * program pointed at it finds no app answering, and no other program can take the port meanwhile (a port bound and
 * let go can be). Never one of OWNER_PORTS. `stop` lets it go.
 */
export function heldPort(): { readonly port: number; readonly stop: () => void } {
  const passed: { stop: (closeActive?: boolean) => void }[] = [];
  for (;;) {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(socket) { socket.end(); }, data() {} } });
    if (!OWNER_PORTS.has(listener.port)) {
      for (const other of passed) other.stop(true);
      return { port: listener.port, stop: () => listener.stop(true) };
    }
    // held until another port is had, so the system does not hand the same one again
    passed.push(listener);
  }
}

const given = new Set<number>();

/**
 * A loopback port for a test to hand to a program that opens it later, or never: free now, never
 * given twice in one process, and outside the ports the system hands out for port 0. A port taken
 * with port 0 and let go can be handed to another test's server before the program gets to it, and
 * what the program then sends there (scripts/plugin.ts asks its PORT for /api/health, with no
 * token) arrives in that test instead.
 */
export function quietPort(): number {
  const range = quietRange(...handedOut());
  // a host that hands out nearly every port has no such port: one of the system's, as before
  if (range === null) {
    const passed: { stop: (closeActive?: boolean) => void }[] = [];
    for (;;) {
      const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      if (OWNER_PORTS.has(probe.port)) { passed.push(probe); continue; }
      const port = probe.port;
      probe.stop(true);
      for (const other of passed) other.stop(true);
      return port;
    }
  }
  const [from, to] = range;
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = from + Math.floor(Math.random() * (to - from + 1));
    if (given.has(port) || OWNER_PORTS.has(port)) continue;
    try {
      Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
      given.add(port);
      return port;
    } catch { /* taken: another one */ }
  }
  throw new Error(`no free port from ${from} to ${to}`);
}
