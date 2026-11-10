/**
 * A loopback port for a test to hand to a program that opens it later, or never: one from below
 * the ports the system hands out for port 0 (32768 and up on Linux, 49152 on macOS and Windows).
 * A port taken with port 0 and let go can be handed to another test's server before the program
 * gets to it, and what the program then sends there (scripts/plugin.ts asks its PORT for
 * /api/health, with no token) arrives in that test instead.
 */
export function quietPort(): number {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    try {
      Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
      return port;
    } catch { /* taken: another one */ }
  }
  throw new Error("no free port below the ones the system hands out");
}
