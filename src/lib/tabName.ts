import { paneTitle } from "../../shared/notify-policy.ts";
import type { HerdrTab, PaneInfo } from "../../shared/protocol.ts";
import { folderName, shortPathTitle, stripPaneChrome } from "./paneName.ts";
import { attachmentTabLabel, shortTabLabel, tabLabelKey } from "./tabLabels.ts";

/**
 * The name a tab was given, or null while herdr names it itself: by its place in the row ("2"),
 * which herdr moves up when a tab before it closes while the tab keeps its number.
 */
export function customTabLabel(tab: Pick<HerdrTab, "label" | "number">, place: number = tab.number): string | null {
  const label = tab.label.trim();
  return label === "" || label === String(place) ? null : label;
}

/** herdr names a tab by its place until it is renamed: the strip says so in words. */
export function tabLabel(tab: Pick<HerdrTab, "label" | "number">, t: (key: string, vars?: Record<string, string | number>) => string, place: number = tab.number): string {
  return customTabLabel(tab, place) ?? t("Tab {n}", { n: place });
}

type TabPane = Pick<PaneInfo, "pane_id" | "terminal_id" | "agent" | "display_agent" | "label" | "title" | "cwd" | "foreground_cwd" | "terminal_title" | "terminal_title_stripped">;

const words = (text: string | null | undefined): string[] => text?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** "codex", "codex --yolo", "claude --resume 3f2a": the agent's command line, its flags and their values */
function commandLine(text: string, agent: readonly string[]): boolean {
  const [first = "", ...rest] = text.split(/\s+/);
  return agent.includes(words(first)[0] ?? "") && rest.every((token, index) => token.startsWith("-") || rest[index - 1]?.startsWith("-") === true);
}

/**
 * The name an agent's pane has for its conversation: the name someone gave the pane, whole, else
 * the agent's own title (herdr's pane title, else its terminal title, without the chrome a row
 * strips) cut as a first message's label is, as the pane's row says it (#2637). A title that only says which
 * agent runs where names nothing a tab could be told by: the agent's name or its command line
 * ("Claude Code", "codex --yolo"), its folder or a path. null for a shell's pane, or for none.
 */
export function agentPaneName(pane: Partial<TabPane>): string | null {
  if (!pane.agent) return null;
  const label = pane.label?.trim();
  if (label) return label;
  const agent = words(pane.agent);
  const said = new Set([...agent, ...words(pane.display_agent), ...[pane.cwd, pane.foreground_cwd].flatMap((path) => path ? words(folderName(path)) : []), "code"]);
  // no title and no folder: nothing, not the pane's id
  for (const title of [pane.title, paneTitle({ ...pane, pane_id: "" })]) {
    const bare = stripPaneChrome(title ?? "", pane.agent).trim();
    // a path says where the pane is, whichever folder it names
    if (shortPathTitle(bare) !== bare) continue;
    // a spinner or glyph in front (Claude's ✳) is not the title
    const text = bare.replace(/^[^\p{L}\p{N}]+/u, "");
    const named = words(text);
    if (named.length === 0 || commandLine(text, agent) || named.every((word) => said.has(word))) continue;
    return shortTabLabel(text);
  }
  return null;
}

/**
 * The label a tab takes from its agent's own name for its conversation (`agentPaneName`), else from
 * its first message (lib/tabLabels.ts): only while herdr names it by its number, never over a name
 * someone gave it (Rename tab, the New tab dialog's Name, a script, an agent's name typed as one).
 * `panes` are the tab's, in the order whose label wins; null when none has one. The tab's hover
 * stays its pane's title.
 */
export function autoTabLabel(tab: Pick<HerdrTab, "label" | "number">, panes: readonly TabPane[], machineId: string, labels: Readonly<Record<string, string>>, place: number = tab.number): string | null {
  if (customTabLabel(tab, place) !== null) return null;
  for (const pane of panes) {
    const learned = labels[tabLabelKey(machineId, pane)];
    const label = agentPaneName(pane) ?? (learned && !attachmentTabLabel(learned) ? learned : null);
    if (label) return label;
  }
  return null;
}
