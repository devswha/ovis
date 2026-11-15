/**
 * Fork only. What scripts/deploy-vps.ts needs of Ricardo's own Ovis: the steps that bring its
 * checkout to origin/main, and its settings file (`~/.config/ovis/env`).
 */

/**
 * The steps, for `&&`, that stop unless the checkout at `repo` is on the main branch. On another
 * branch (a PR under test there) a deploy would replace that build, and a pull would fail or move the
 * branch to main; they stop first, changing nothing, as the server's own updater does ("Switch the
 * source checkout to main to update.").
 */
export function onMainSteps(repo: string): string[] {
  return [
    `cd ${repo}`,
    `if [ "$(git branch --show-current)" != main ]; then echo "deploy-vps: the checkout is on '$(git branch --show-current)', not main, and only main is deployed: switch it to main first (nothing was changed)" >&2; exit 1; fi`,
  ];
}

/** The steps, for `&&`, that bring the checkout at `repo` to origin/main: `git pull --ff-only origin main`, but only on main. */
export function pullMainSteps(repo: string): string[] {
  return [...onMainSteps(repo), "git pull --ff-only origin main"];
}

/**
 * `text`, a file of `KEY=value` lines, with `name` set to `value`: each line that sets it changed in
 * place (the last one wins), or one added after the others. Comments and the other
 * lines stay as they are.
 */
export function withSetting(text: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const lines = text.split("\n");
  const sets = (candidate: string) => candidate.trim().split("=")[0]!.trim() === name;
  if (lines.some(sets)) return lines.map((candidate) => (sets(candidate) ? line : candidate)).join("\n");
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`;
}

/** The value `text`, a file of `KEY=value` lines, gives `name` (the last line that sets it, unquoted), or null. */
export function settingOf(text: string, name: string): string | null {
  const lines = text.split("\n").filter((line) => line.trim().split("=")[0]!.trim() === name);
  const value = lines.at(-1)?.slice(lines.at(-1)!.indexOf("=") + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  return value ? value : null;
}

export type DeployMachine = { id: string; name: string; kind: string; state: string; error: string | null; target?: { destination?: string; own_ovis?: string } };

/**
 * Which of the PCs `pcs` the server's `/api/machines` list `machines` does not show as `connected`
 * (matched by id: names need not be unique), each as a phrase for the failure message with its error.
 */
export function notConnected(machines: { id: string; name: string; state: string; error: string | null }[], pcs: { id: string; name: string }[]): string[] {
  return pcs.flatMap((pc) => {
    const machine = machines.find((candidate) => candidate.id === pc.id);
    if (!machine) return [`${pc.name} (not listed)`];
    return machine.state === "connected" ? [] : [`${pc.name} (${machine.error ? `${machine.state}: ${machine.error}` : machine.state})`];
  });
}

/** The roster in a `/api/machines` answer. An error answer (a 401 without the token) or one without a roster is refused, not read as no PCs: the deploy would then update none and restart anyway. */
export async function machinesOf(response: Response): Promise<DeployMachine[]> {
  if (!response.ok) throw new Error(`/api/machines answered ${response.status}`);
  const body = await response.json().catch(() => null) as { machines?: unknown } | null;
  if (!Array.isArray(body?.machines)) throw new Error("/api/machines answered without a machine roster");
  return body.machines as DeployMachine[];
}

export interface RollOutSteps {
  /** the server's `/api/machines`; aborted by `signal` when the wait for connections runs out */
  listMachines(signal: AbortSignal): Promise<DeployMachine[]>;
  /** brings that PC's own Ovis to this commit and restarts it; false when it could not */
  updatePc(pc: DeployMachine): boolean;
  restart(): void;
  /** what must hold once the server is back (it runs the commit, serves the bundle) */
  afterRestart(): Promise<void>;
}

/**
 * The order that matters in a deploy: every PC's own Ovis is updated while the server still runs (a server
 * started against a PC on old code parks it in "error" and never retries), then the server restarts, then
 * every PC that was updated must show connected within `connectMs`, each request bounded by what is left.
 * Throws when the PC list cannot be read, before anything changed.
 */
export async function rollOut(steps: RollOutSteps, options: { connectMs?: number; pollMs?: number } = {}): Promise<{ pcs: DeployMachine[]; stale: DeployMachine[]; waiting: string[] }> {
  const { connectMs = 60_000, pollMs = 1000 } = options;
  const listed = await steps.listMachines(AbortSignal.timeout(30_000)).catch((error) => { throw new Error(`the server's PC list cannot be read, so the PCs to update are unknown: ${error instanceof Error ? error.message : error}`); });
  const pcs = listed.filter((machine) => machine.kind === "ssh" && machine.target?.own_ovis && machine.target.destination);
  const stale = pcs.filter((pc) => !steps.updatePc(pc));
  steps.restart();
  await steps.afterRestart();
  const updated = pcs.filter((pc) => !stale.includes(pc));
  const deadline = Date.now() + connectMs;
  let waiting = updated.map((pc) => pc.name);
  while (updated.length) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    waiting = notConnected(await steps.listMachines(AbortSignal.timeout(left)).catch(() => []), updated);
    if (!waiting.length) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  return { pcs, stale, waiting: updated.length ? waiting : [] };
}
