### Fixed
- A Markdown link to a network share (`[x](//host/share/a.md)`, also written with backslashes,
  percent-encoded or after `~/`) is no longer a clickable file link: on a Windows PC opening it asked
  that host for the file with your sign-in. A `file:///` link and a Codex citation already refused one.
- A connection, a watch-only device included, can no longer make the PC run more than 64 of the
  processes that draw a watched pane: a watch names its pane by a pane's id, a pane has one such
  process at a time, and one connection watches at most 64 panes.
- A message of tens of thousands of line breaks followed by a letter no longer stalls the PC's
  server, and every terminal with it, while it is refused.
