# DeepSeek Harness conversations

On Linux, the chat lens reads the native DeepSeek Harness v4 session log. It supports plain JSONL and concatenated Zstandard frames. It identifies the session through the `session.lock` file held open by the pane's foreground dsh process. It does not select a session by directory or modification time. A new idle dsh process with no session lock shows an empty chat until its first message creates the log. Explicit resume requests and processes previously observed holding a lock do not use this empty-chat state. Missing or ambiguous bindings use the terminal fallback.

The store boundary follows the foreground process’s `DSH_HOME`, or its `HOME` plus `.dsh` when `DSH_HOME` is unset or blank. The session log’s real path must remain inside the real `sessions/` directory. Symlinked store roots are supported; links from a session to an outside log are rejected. The reader pins the file identity and checks it again for conversation and tool-output reads.

The published `@deepseek-ai/dsh-home-paths` package (0.1.7-rc.1 and 0.2.1-rc.2) defines the home override. The `@deepseek-ai/dsh-base` 0.1.7-rc.1 profile configures `session-persistence-jsonl` with `root: !!js dshHomePath('sessions')`. That persistence plugin also accepts a custom `root` through Cordis configuration. Ovis does not evaluate Cordis patches. A custom root outside the standard sessions directory, a relative `DSH_HOME`, or an unreadable process environment uses the terminal fallback. Absolute and home-relative (`~/…`) `DSH_HOME` values are supported.

The reader shows human messages, assistant text and recorded reasoning, tool calls, tool results, and turn completion. System instructions and runtime user-message injections stay hidden. Compaction checkpoints appear as compaction markers; earlier chat remains available. Attachments appear as notices and can be viewed in the terminal.

The newest page contains up to 50 turns. Cursors bind to the session, file identity, and preceding conversation content. Tool output is shortened in the page and can be expanded. Reads limit both compressed input and decompressed output to 16 MiB. Larger logs, unsupported versions, damaged complete frames, and unsupported surface events use the terminal fallback. An unfinished final frame is ignored until its append completes.

This adapter requires Bun with Zstandard decompression support. Session binding currently requires Linux procfs and the same OS user as dsh. It does not add macOS or Windows binding. It reads committed native messages; it does not reconstruct unfinished model streams.

Chat sends use the existing composer. If herdr returns `agent_not_ready` or `agent_not_found`, the composer sends text and Enter through its guarded terminal path. Authorization checks remain active. It does not retry a prompt after an uncertain delivery error.
