/** Job runners and assistants keep running in hc but belong in no Ovis list or alert. */
export function hiddenTerminal(labels: Readonly<Record<string, string>> | undefined): boolean {
  return labels?.["ovis.view"] === "work";
}
