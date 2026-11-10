### Added
- Settings → Appearance → Theme file imports a theme from a file of colors: a Base16 scheme as its
  projects publish it (YAML or JSON), or one JSON file with a dark and a light side. Only colors
  are read from a file, never code or CSS. Ovis derives every color it draws from the sixteen and
  holds them to the contrast floors of its own themes, so text stays readable whatever the file
  says. An imported theme is a card beside the built-in ones, is shared with the other devices of
  the PC, and is drawn from the first frame. [docs/themes.md](docs/themes.md) describes the file.
