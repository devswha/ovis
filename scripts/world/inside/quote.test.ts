import { describe, expect, it } from "bun:test";
import { shellQuoted } from "./quote.ts";

/** what term.sh does with `machine.ts env`'s lines: eval them, then the terminal's command reads the value */
const evaluated = (value: string) => Bun.spawnSync(["sh", "-c", 'eval "$0"; printf "%s" "$OVIS_PROBE"', `export OVIS_PROBE=${shellQuoted(value)}`], { stdout: "pipe", stderr: "pipe" });

describe("the server environment term.sh evals", () => {
  it("comes back exactly as given, however it is written, and runs nothing", () => {
    for (const value of ["plain", "$(echo ran)", "`echo ran`", "it's \"quoted\" \\ $HOME", "a\tb  c", "'", ""]) {
      const ran = evaluated(value);
      expect([ran.exitCode, ran.stdout.toString(), ran.stderr.toString()]).toEqual([0, value, ""]);
    }
  });
});
