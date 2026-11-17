import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function testShellEnv(dir: string): Record<string, string> {
  if (process.platform === "win32") return {};
  if (!existsSync("/bin/bash")) return { SHELL: "/bin/sh" };
  mkdirSync(dir, { recursive: true });
  const shell = join(dir, "test-bash");
  // Keep the long options before herdr's flags, including -l. Noninteractive bash also
  const inputrc = join(dir, "test-inputrc");
  writeFileSync(inputrc, "set input-meta on\nset output-meta on\nset convert-meta off\n");
  writeFileSync(shell, `#!/bin/sh\nunset BASH_ENV ENV\nINPUTRC='${inputrc.replaceAll("'", "'\\''")}'\nexport INPUTRC\nn=$#\nwhile [ "$n" -gt 0 ]; do a=$1; shift; n=$((n - 1)); case "$a" in -l|--login) ;; *) set -- "$@" "$a" ;; esac; done\nexec /bin/bash --noprofile --norc "$@"\n`, { mode: 0o700 });
  chmodSync(shell, 0o700);
  return { SHELL: shell };
}
