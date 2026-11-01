### Fixed
- A queued follow-up stays in Chat as a sent message from the moment it leaves its row until its
  turn shows: at the end of a turn, after Send now, and when the turn ended before it arrived.
- After Stop, a message sent in place of the stopped one no longer brings the stopped message back
  into Chat for a moment.
- Stop with a follow-up queued no longer erases the stopped message from Claude Code's input box:
  the stopped message comes back to the composer, and the follow-up waits for Send now.
- Clicking Stop keeps the keyboard focus in the message box, as Send does.
