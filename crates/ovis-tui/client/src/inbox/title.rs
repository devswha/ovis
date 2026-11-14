//! A row's title and tab name, as the web's Agents list draws them (src/components/AgentSidebar.tsx
//! `rowTitle`, `agentRowTitle`; src/components/Sidebar.tsx `displayPaneTitle`; shared/pane-title.ts;
//! src/lib/sidebarAgents.ts `titleOnlyNamesAgent`, `agentTabName`; src/lib/tabName.ts).

use crate::api::{AgentInfo, Pane, Tab, Workspace};

/// The agents with a mark of their own (src/components/AgentMark.tsx `DRAWN_MARKS` and
/// src/components/agentSvgMarks.ts).
const MARKED: &[&str] = &[
    "claude", "omp", "codex", "cursor", "opencode", "gjc", "omo", "agy", "amp", "cline", "copilot",
    "devin", "droid", "dsh-tui", "gemini", "grok", "hermes", "kilo", "kimi", "kiro", "letta",
    "maki", "muse", "pi", "qodercli", "qwen",
];

/// Product names by agent kind (shared/agent-catalog.ts `AGENT_CATALOG`).
const NAMES: &[(&str, &str)] = &[
    ("claude", "Claude Code"),
    ("codex", "Codex"),
    ("copilot", "GitHub Copilot"),
    ("opencode", "OpenCode"),
    ("devin", "Devin CLI"),
    ("grok", "Grok Build"),
    ("agy", "Antigravity"),
    ("omp", "Oh My Pi"),
    ("omo", "OmO"),
    ("gjc", "Gajae Code"),
    ("pi", "pi"),
    ("letta", "Letta Code"),
    ("cmd", "Command Code"),
    ("muse", "Muse Code"),
    ("dsh-tui", "DeepSeek Harness"),
    ("hermes", "Hermes"),
];

pub(crate) fn nonblank(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// A pane's live title: its terminal title, else its folder, else its id.
fn pane_title(pane: &Pane) -> &str {
    match pane
        .terminal_title_stripped
        .as_deref()
        .or(pane.terminal_title.as_deref())
    {
        Some(title) if !title.trim().is_empty() => title,
        _ => pane
            .cwd
            .as_deref()
            .filter(|cwd| !cwd.is_empty())
            .unwrap_or(&pane.pane_id),
    }
}

/// `user@host:` in front of a shell's title.
fn without_shell_prefix(title: &str) -> &str {
    let plain = |c: char| c != ':' && c != '@' && !c.is_whitespace();
    let Some(at) = title.find('@') else {
        return title;
    };
    let (user, rest) = title.split_at(at);
    let host_and_more = rest.get(1..).unwrap_or_default();
    let Some(colon) = host_and_more.find(':') else {
        return title;
    };
    let host = host_and_more.get(..colon).unwrap_or_default();
    if user.is_empty() || host.is_empty() || !user.chars().all(plain) || !host.chars().all(plain) {
        return title;
    }
    host_and_more.get(colon + 1..).unwrap_or_default()
}

/// herdr's agent glyph `π`, a spinner after it, and the spaces around them.
fn without_agent_chrome(title: &str) -> &str {
    let Some(rest) = title.strip_prefix('π') else {
        return title;
    };
    let rest = rest.trim_start();
    let rest = match rest.chars().next() {
        Some(c) if !c.is_alphanumeric() && !c.is_whitespace() => {
            rest.get(c.len_utf8()..).unwrap_or_default()
        }
        _ => rest,
    };
    rest.trim_start()
}

/// Codex's `<thread> | <folder>` keeps the thread.
fn codex_thread(title: &str) -> &str {
    match title.rfind(" | ") {
        Some(at) if at > 0 && !title.get(..at).unwrap_or_default().trim().is_empty() => {
            title.get(..at).unwrap_or(title)
        }
        _ => title,
    }
}

fn strip_chrome<'a>(title: &'a str, agent: Option<&str>) -> &'a str {
    let shell = without_shell_prefix(title);
    match agent.filter(|agent| !agent.is_empty()) {
        None => shell,
        Some("codex") => codex_thread(without_agent_chrome(shell)),
        Some(_) => without_agent_chrome(shell),
    }
}

/// A path's last folder, split on either platform's separator.
fn folder_name(path: &str) -> String {
    let Some(last) = path.split(['/', '\\']).rfind(|part| !part.is_empty()) else {
        return path.to_owned();
    };
    let drive = last.len() == 2
        && last.ends_with(':')
        && last.starts_with(|c: char| c.is_ascii_alphabetic());
    if drive {
        format!("{last}{}", path.get(2..3).unwrap_or("\\"))
    } else {
        last.to_owned()
    }
}

/// A title that is a path shows as its last folder.
fn short_path_title(title: &str) -> String {
    let trimmed = title.trim();
    let mut chars = trimmed.chars();
    let path = match (chars.next(), chars.next(), chars.next()) {
        (Some('~'), None | Some('/' | '\\'), _) | (Some('/'), _, _) => true,
        (Some(drive), Some(':'), Some('/' | '\\')) => drive.is_ascii_alphabetic(),
        _ => false,
    };
    if path {
        folder_name(trimmed)
    } else {
        title.to_owned()
    }
}

fn display_pane_title(pane: &Pane) -> String {
    if let Some(label) = nonblank(pane.label.as_deref()) {
        return label.to_owned();
    }
    let short = short_path_title(strip_chrome(pane_title(pane), pane.agent.as_deref()));
    if short.is_empty() {
        pane.pane_id.clone()
    } else {
        short
    }
}

fn agent_name(kind: &str) -> &str {
    NAMES
        .iter()
        .find(|(id, _)| *id == kind)
        .map_or(kind, |(_, name)| name)
}

/// Whether a title says nothing but which agent it is, a glyph before it aside.
fn title_only_names(title: &str, names: &[&str]) -> bool {
    let plain = |text: &str| {
        text.trim_start_matches(|c: char| !c.is_alphanumeric())
            .trim()
            .to_lowercase()
    };
    let said = plain(title);
    !said.is_empty() && names.iter().any(|name| plain(name) == said)
}

fn compact_worktree_name(label: &str) -> &str {
    let Some(rest) = label.strip_prefix("worktree-") else {
        return label;
    };
    let Some((name, hash)) = rest.rsplit_once('-') else {
        return label;
    };
    let generated = !name.is_empty()
        && hash.len() == 4
        && hash
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c));
    if generated { name } else { label }
}

/// What a row's title says about a pane, and who names it.
pub(crate) struct Named<'a> {
    pub pane: &'a Pane,
    pub agent: Option<&'a AgentInfo>,
    pub workspace: &'a Workspace,
    pub canonical: Option<&'a str>,
    pub label: Option<&'a str>,
}

/// The title a two-line row draws: the pane's label, else its agent's title, else the pane's own;
/// one that only names the agent its mark already shows gives way to the workspace's name.
pub(crate) fn row_title(named: &Named<'_>) -> String {
    let own = nonblank(named.pane.label.as_deref())
        .or_else(|| nonblank(named.agent.and_then(|agent| agent.title.as_deref())))
        .or_else(|| nonblank(named.pane.title.as_deref()))
        .map_or_else(|| display_pane_title(named.pane), str::to_owned);
    let mark = named.canonical.or(named.label).unwrap_or_default();
    let names: Vec<&str> = match named.canonical {
        Some(canonical) if MARKED.contains(&mark) => vec![canonical, agent_name(canonical)],
        _ => Vec::new(),
    };
    let replaced =
        nonblank(named.pane.label.as_deref()).is_none() && title_only_names(&own, &names);
    match (
        replaced,
        named
            .workspace
            .worktree
            .as_ref()
            .is_some_and(|tree| tree.is_linked_worktree),
    ) {
        (false, _) => own,
        (true, true) => compact_worktree_name(&named.workspace.label).to_owned(),
        (true, false) => named.workspace.label.clone(),
    }
}

/// The tab a row names: only beside another tab of its workspace, or once it was renamed.
pub(crate) fn tab_name(tab: Option<&Tab>, workspace_tabs: &[&Tab]) -> Option<String> {
    let tab = tab?;
    let place = workspace_tabs
        .iter()
        .position(|candidate| candidate.tab_id == tab.tab_id)
        .and_then(|at| u32::try_from(at).ok())
        .map_or(tab.number, |at| at.saturating_add(1));
    let label = tab.label.trim();
    let custom = (!label.is_empty() && label != place.to_string()).then(|| label.to_owned());
    if workspace_tabs.len() > 1 || custom.is_some() {
        Some(custom.unwrap_or_else(|| format!("Tab {place}")))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_lose_chrome_and_paths_as_the_web_strips_them() {
        let cases: &[(&str, Option<&str>, &str)] = &[
            ("me@box:~/dev/api", None, "api"),
            ("/home/me/dev/web", None, "web"),
            ("π ⠋ Fix the login", Some("omp"), "Fix the login"),
            (
                "Respond to greeting | worktree-x",
                Some("codex"),
                "Respond to greeting",
            ),
            ("C:\\work\\api", None, "api"),
            ("plain words", Some("claude"), "plain words"),
        ];
        for (title, agent, shown) in cases {
            assert_eq!(
                short_path_title(strip_chrome(title, *agent)),
                *shown,
                "{title}"
            );
        }
    }

    #[test]
    fn worktree_names_drop_only_what_herdr_added() {
        assert_eq!(
            compact_worktree_name("worktree-brave-valley-7fc6"),
            "brave-valley"
        );
        assert_eq!(
            compact_worktree_name("worktree-brave-valley"),
            "worktree-brave-valley"
        );
        assert_eq!(compact_worktree_name("api"), "api");
    }
}
