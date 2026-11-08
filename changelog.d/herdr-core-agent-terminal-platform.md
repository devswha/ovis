### Fixed
- On herdr-core, a pane on another machine is named after its agent the way that machine's own
  platform names programs: a Windows machine's `letta.cmd` shows as Letta when Ovis runs on Linux,
  and a Linux machine's Command Code (`cmd`) is no longer hidden as the Windows command prompt when
  Ovis runs on Windows. Where the machine's platform cannot be told, such a pane names no agent
  rather than a wrong one, and a terminal started directly as an agent is named even before
  herdr-core reports the process in front of it.
