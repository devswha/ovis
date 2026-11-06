### Fixed
- A chat message to Codex is no longer typed into one of Codex's own lists or fields (/model,
  /permissions, /review, /theme, /resume, /statusline, /rename, the agents and transcript views),
  which herdr reports at rest: the paste was dropped and its Enter took the row under the cursor,
  which could save a model as the default for every new session. It is refused before anything is
  typed and stays in the message box.
- Codex at Ultra reasoning effort, which draws its composer as `»`: the still-open notice arms, a
  fresh pane opens as an empty chat with its model and effort, and its first answer is matched to
  the conversation instead of leaving the chat unavailable.
