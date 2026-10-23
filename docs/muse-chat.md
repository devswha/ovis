# Muse Code Chat

Chat reads the Muse Code session log of the session on screen: user messages, assistant
answers, reasoning summaries and expandable tool activity, in the existing Chat view. Terminal
remains the place for approvals, questions and Muse's own commands. Reading Chat makes no model
call and needs no Muse configuration.

## Finding the session

herdr labels a pane that runs `muse`, or the versioned `muse-bin-…` binary its launcher starts,
as `muse`, but reports no session for it. Muse writes `.session.lock` into each session
directory it opens, with `pid=<pid>` and, on recent builds, `host=<host>`, and never removes it.

The reader takes the pane's one Muse foreground process, then the top-level locks under
`${XDG_DATA_HOME:-~/.local/share}/muse/sessions/YYYY/MM/DD/<id>/` that name its pid (and this
PC's host name, when a lock names one) and were written since that process started. A lock left
by an earlier process with the same pid is older than the process, so it never counts. A session
the TUI switched away from ends its log with `session.end` and is dropped, as is a lock whose log
does not exist yet. Exactly one session must be left; otherwise Chat uses Terminal. Folder,
recency and argv never choose a session, so panes in one folder each show their own, and an
in-TUI `/resume` is followed at once: Muse writes the resumed session's lock and its
`session.resumed` record as it switches.

The data directory comes from the server's `XDG_DATA_HOME`; a Muse started with another one
uses Terminal. A process's start time comes from `ps` on macOS (whole seconds, so a three-second
margin) and `/proc` on Linux. Windows uses Terminal. Each read checks the lock time of every
session in the store.

## What is read

- **Prompts:** `runtime.user_intent.accepted`, once per message sent, including one sent while
  Muse works. `run/started` repeats the words and is not read.
- **Answers:** `assistant_message_committed`. Muse marks progress prose `commentary`, which folds
  into the turn's work block; the rest is the answer.
- **Reasoning:** `reasoning_summary_committed`. `reasoning_committed` is encrypted and skipped.
- **Tools:** calls from `assistant_tool_calls_committed`, results from
  `tool_result_batch_committed` by call id. A JSON envelope shows its `output`, and a non-zero
  `exit_code` marks the call failed, as do Muse's own `tool denied: …` and `tool failed: …`;
  any other result is shown as written.
  **Show all** reads the whole result from the log.
- **Compaction:** the `summary_text` of `context_compaction_installed`.
- **Model:** `run.model.configured` and each `model_completed`. Muse records no reasoning effort
  and no context window, so neither is shown.

These record shapes are the same from Muse 1.4.2 to 1.4.12. Lines without one of them are skipped
before they are parsed, so a long session reads in tens of milliseconds.

## Limits

- Prompt cards, slash commands, todos and plans, subagents, images and Earlier sessions are
  outside this first scope.
- A result shows what the model received. Muse keeps longer originals in the session's
  `tool-outputs/`, which is not read.
- A result recorded after a later prompt, while its call is on an earlier page, shows on a row of
  its own.
- What `/rewind` records is not handled yet: Chat can keep the turns it went back over.

## Verification

```sh
HERDR_TEST_MODE=unit bun test ./server/muse.test.ts
bun run check run bun test --timeout 15000 ./server/api.contract.test.ts --test-name-pattern 'Muse conversation API'
bun run check fast
```

The fixture in `server/fixtures/muse/` is fictional, written in the record shapes of real 1.4.12
logs. The contract test runs a stand-in process named `muse` in an isolated herdr, checks that a
lock naming another pid binds nothing, then reads the bound session over HTTP, its whole tool
output, and a switch to a second session. It does not run the Muse TUI.
