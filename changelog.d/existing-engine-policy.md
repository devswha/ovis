### Changed
- Entries beside an owner's engine can select an explicit existing-only lifecycle policy. The fleet
  bridge uses it for every herdr-core connection, including background requests and reconnections.
  Ordinary Ovis startup keeps its existing ability to start herdr-core.
### Fixed
- A fleet bridge rejects control characters in `HC_SOCKET` without echoing the path. When core
  session directories cannot be read, it stays available and reports the permission problem.
