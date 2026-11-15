type Parts = Record<string, Record<string, string>>;

// These labels still occur in upstream components; other fork labels belong to the base dictionary.
const OWNERS: Record<string, string> = {
  "Switch model": "composer",
  "Switch the model once the agent is idle": "composer",
  "Start live voice": "composer",
  "Show offline ({count})": "machines",
  "Hide offline PCs": "machines",
  "Pull requests…": "sidebar",
};
// Extracted components also use these upstream labels, so they are no longer private to one part.
const SHARED = ["No microphone found", "Working folder", "Worktree", "Draft", "Close pane {name}?", "The pane's running processes will stop. Closing its last pane also closes the workspace."];

/** Extend upstream dictionaries without changing their files or their ownership tests. */
export function withForkI18n<T extends Parts>(parts: T, fork: Record<string, string>): T {
  const result = Object.fromEntries(Object.entries(parts).map(([name, entries]) => [name, { ...entries }])) as T;
  const put = (key: string, value: string, owner: string) => {
    for (const entries of Object.values(result)) delete entries[key];
    result[owner]![key] = value;
  };
  for (const key of SHARED) {
    const value = Object.values(result).find((entries) => key in entries)?.[key];
    if (value !== undefined) put(key, value, "base");
  }
  for (const [key, value] of Object.entries(fork)) put(key, value, OWNERS[key] ?? "base");
  return result;
}
