### Fixed
- On herdr-core, a chat message to a Claude Code that was typed at a shell prompt is no longer
  refused with "Claude Code's input box in the terminal may not be empty" while the box shows only
  Claude's grey tip or suggested prompt. hc paints the shell's lines before the full-screen
  program's screen, and Ovis read the shell's last line into that screen's top row, so its colors
  never matched the screen. Such a program is now also read without history, as one started on its
  own already was, so Ovis no longer makes hc scroll it to read its history (#3128).
