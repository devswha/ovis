### Fixed
- Chat now shows a fresh Codex pane's conversation by its last turn in a folder with more than 32
  Codex threads, when Codex holds that thread loaded. It also does so next to an older thread of the
  folder whose last turn ended on a very long tool output. Before, both kept the pane on
  "Conversation unavailable". When the thread still cannot be proven, the pane stays in the terminal.
