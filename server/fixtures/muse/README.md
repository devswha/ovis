# Fictional Muse Code session

`session.jsonl` is written by hand in the record shapes of Muse Code 1.4.12, compared field by
field with real session logs on 2026-10-22. Every text, path, command and id is fictional; no
user history was copied. Long payloads Muse also writes (base instructions, hook bookkeeping,
task lifecycle rows) are left out or cut to one record, since the reader skips them.

It holds two prompts. The first runs five tool calls: a passing and a failing `bash` (JSON
envelope with `exit_code`), a `read_file` with plain text, a call the user declined (`tool
denied: …`) and one whose output is longer than a page carries. Reasoning, a commentary-phase
answer and a final answer surround them. Between the prompts, `/model` switches the model. The
second prompt holds a compaction summary. `run/started` repeats each prompt and must not.
