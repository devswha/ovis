### Fixed
- Skill discovery on Windows: resolve the user home directory from `USERPROFILE` or `homedir()` when `HOME` is unset, so global skills and prompts across agents (Pi, Antigravity, Claude, Codex, OMO) are discovered on native Windows.
