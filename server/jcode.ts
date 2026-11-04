/**
 * Jcode's own process identity for a pane: the foreground program is `jcode`, launched either
 * directly (the installer's binary, `jcode.exe` on Windows) or through a bun/node shim
 * (`bun /…/jcode …`, how a source build is run), never another program that merely names it.
 *
 * Jcode keeps a client/daemon pair: every session is a `jcode` client that talks to the shared
 * `jcode server` daemon. Only the client is a pane's foreground process, so this test names one
 * pane's agent, not the daemon that outlives it.
 */
import { runsAgent } from "./gjc-runtime.ts";

const JCODE_EXECUTABLE = /(^|[\\/])jcode(?:\.exe)?$/i;

export function isJcodeProcess(argv: readonly string[]): boolean {
  return runsAgent(argv, JCODE_EXECUTABLE);
}
