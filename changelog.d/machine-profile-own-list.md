### Added
- The machine profile (a preview) answers `GET /api/machines` with its own machine alone, under the
  machine's host name and with its terminals, so a phone that opened it through the relay lists its
  workspaces instead of "Loading PCs…" under an error. While its herdr is down the machine is listed
  with the reason its health gives. Every other route under `/api/machines` stays unavailable in the
  profile: it manages no other PC.
