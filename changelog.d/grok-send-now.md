### Fixed
- In chat, Send now on a working Grok pane sends the message at once when it is the only row in
  Grok's queue: one more Enter on Grok's empty prompt, which ends the turn at work. When rows
  were queued in Grok before it, or Grok's screen shows a dialog, typed text or anything but its
  empty prompt, nothing more is pressed: the message stays queued in Grok, and its row says so
  and offers no second Send now. A plain Send to a working Grok still queues behind the turn.
