### Added
- Edit queued or held messages back into the composer without replacing its existing draft.
### Fixed
- Pi transcript confirmation reads bounded history tails and new entries instead of re-reading
  the whole conversation, and tolerates ongoing appends without accepting partial records.
- Exact Pi delivery receipts reconcile after browser reconnection or reload without clearing
  unrelated messages that happen to have the same text.
