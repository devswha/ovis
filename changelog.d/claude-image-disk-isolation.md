### Fixed
- Claude conversation images load on a separate, bounded worker so a slow transcript disk read
  leaves terminal traffic, commands, task lists and other file requests responsive.
